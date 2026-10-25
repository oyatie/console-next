use crate::*;

mod binding;
mod members;
mod op;

pub(crate) use binding::*;
pub(crate) use members::*;
pub(crate) use op::*;

/// What an apply did: the audit rows and how many people it moved.
pub(crate) struct Applied {
    pub(crate) audits: Vec<AuditEvent>,
    pub(crate) people: i64,
}

/// Replays `request`'s ops in order inside the caller's transaction. A move of
/// a unit to another 사업장 moves its people with it, and a reassign moves the
/// members, each as a dated event caused by the change (org-01, org-04).
pub(crate) async fn apply_ops(
    tx: Tx<'_, '_>,
    (org, actor, now): (OrgId, UserId, OffsetDateTime),
    id: Uuid,
    request: &RequestRow,
    employment_transfer: Option<&dyn EmploymentTransferPort>,
    org_unit_write: Option<&dyn OrgUnitWritePort>,
) -> Result<Applied, PgOrgChangeError> {
    assert_change_window_open(tx, request.effective_date).await?;
    replay_ops(
        tx,
        (org, actor, now),
        id,
        request,
        employment_transfer,
        org_unit_write,
    )
    .await
}

/// The same proposal replay for apply and its rolled-back preflight.
pub(crate) async fn replay_ops(
    tx: Tx<'_, '_>,
    (org, actor, now): (OrgId, UserId, OffsetDateTime),
    id: Uuid,
    request: &RequestRow,
    employment_transfer: Option<&dyn EmploymentTransferPort>,
    org_unit_write: Option<&dyn OrgUnitWritePort>,
) -> Result<Applied, PgOrgChangeError> {
    let ops = &request.proposal;
    // A draft stored before decisions #18 may still hold a retired op.
    refuse_retired(ops)?;
    // Fail closed on the wiring defect BEFORE the per-op conflict mapping: a
    // missing port is a composition error (→ 500), not a proposal conflict
    // (→ 409). A move may now carry its people, so it needs the port too.
    if employment_transfer.is_none()
        && ops.iter().any(|op| {
            matches!(
                op,
                OrgProposalOp::ReassignOrgUnit { .. } | OrgProposalOp::MoveOrgUnit { .. }
            )
        })
    {
        return Err(PgOrgChangeError::from(KernelError::internal(
            "employment transfer port is not wired; people cannot move with the change",
        )));
    }
    if org_unit_write.is_none() && ops.iter().any(is_org_unit_op) {
        return Err(PgOrgChangeError::from(KernelError::internal(
            "org-unit write port is not wired; *_ORG_UNIT ops cannot apply",
        )));
    }
    let mut applied = Applied {
        audits: Vec::with_capacity(ops.len()),
        people: 0,
    };
    let mut people = std::collections::BTreeSet::new();
    for (index, op) in ops.iter().enumerate() {
        // The operation receipt connects projected creations to their canonical IDs.
        let command_id = console_orgchange_domain::projection::projected_unit_id(id, index);
        let moved = apply_one(
            tx,
            (org, actor, now, command_id),
            (id, request),
            op,
            employment_transfer,
            org_unit_write,
        )
        .await
        .map_err(|e| wrap_op_error(index, e))?;
        applied.audits.extend(moved.audits);
        people.extend(moved.employee_ids);
    }
    applied.people = i64::try_from(people.len()).unwrap_or(i64::MAX);
    Ok(applied)
}

/// One op: its own write, then the people it moves (their audits after it).
async fn apply_one(
    tx: Tx<'_, '_>,
    (org, actor, now, command_id): (OrgId, UserId, OffsetDateTime, Uuid),
    (id, request): (Uuid, &RequestRow),
    op: &OrgProposalOp,
    employment_transfer: Option<&dyn EmploymentTransferPort>,
    org_unit_write: Option<&dyn OrgUnitWritePort>,
) -> Result<PeopleMoved, PgOrgChangeError> {
    let cause = move_cause(id, request);
    match op {
        OrgProposalOp::ReassignOrgUnit {
            from_org_unit,
            to_org_unit,
            scope,
            employee_ids,
        } => {
            let unit = |text: &str| {
                Uuid::parse_str(text.trim()).map_err(|_| {
                    PgOrgChangeError::from(KernelError::validation(
                        "fromOrgUnit/toOrgUnit must be OrgUnit UUIDs, not free-text team labels",
                    ))
                })
            };
            let (from, to) = (unit(from_org_unit)?, unit(to_org_unit)?);
            if from == to {
                return Err(KernelError::validation(
                    "REASSIGN_ORG_UNIT source and target must differ",
                )
                .into());
            }
            let what = PeopleMove::Reassign {
                from,
                to,
                people: employee_ids.clone(),
            };
            let mut moved = move_people(tx, (org, actor), cause, what, employment_transfer).await?;
            let event = audit(
                org,
                actor,
                "org_change.apply.op",
                "org_unit",
                format!("{}/{}", scope.company, to_org_unit),
                now,
            )?
            .with_snapshots(
                Some(serde_json::json!({ "orgUnit": from_org_unit })),
                Some(serde_json::json!({ "orgUnit": to_org_unit, "employeesMoved": moved.people })),
            );
            moved.audits.insert(0, event);
            Ok(moved)
        }
        op if is_org_unit_op(op) => {
            let port = org_unit_write.ok_or_else(|| {
                PgOrgChangeError::from(KernelError::internal("org-unit write port is not wired"))
            })?;
            let event = apply_org_unit_op(
                tx,
                org,
                actor,
                command_id,
                op,
                request.effective_date,
                now,
                port,
            )
            .await?;
            let mut moved = match op {
                // The unit is re-parented now: its people follow its 사업장.
                OrgProposalOp::MoveOrgUnit { org_unit_id, .. } => {
                    let units = subtree(tx, *org_unit_id).await?;
                    let what = PeopleMove::Follow { units };
                    move_people(tx, (org, actor), cause, what, employment_transfer).await?
                }
                _ => PeopleMoved::default(),
            };
            moved.audits.insert(0, event);
            Ok(moved)
        }
        op => Ok(PeopleMoved {
            people: 0,
            employee_ids: Vec::new(),
            audits: vec![apply_op(tx, org, actor, command_id, op, now).await?],
        }),
    }
}

/// Preserve the op's kind AND the freeze marker: a closed window stays
/// Frozen(Conflict) so `record_freeze_refusal` fires, while a gate/lookup
/// failure stays Internal (500) instead of being collapsed into a retry-never
/// 409. A coded refusal keeps its code (decisions #18 codes reach the client).
fn wrap_op_error(index: usize, e: PgOrgChangeError) -> PgOrgChangeError {
    let mut wrapped = KernelError::new(
        e.kind(),
        format!("proposal op {index} failed: {}", e.message()),
    );
    if let PgOrgChangeError::Domain(k) | PgOrgChangeError::Frozen(k) = &e {
        wrapped.code = k.code;
    }
    if matches!(&e, PgOrgChangeError::Frozen(_)) {
        PgOrgChangeError::Frozen(wrapped)
    } else {
        PgOrgChangeError::from(wrapped)
    }
}
