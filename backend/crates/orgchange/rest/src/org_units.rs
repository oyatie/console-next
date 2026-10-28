use crate::*;
use console_platform_request_context::audit_context::access_log::AccessRecord;

pub(crate) async fn list_org_units(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_read(&p)?;
    let units = s.store.list_org_units().await.map_err(RestError::store)?;
    access_log::record(
        &s,
        &p,
        AccessRecord {
            action: "org_unit.list_read",
            target_type: "org_unit",
            target_id: "query".into(),
            subject_ids: &[],
            reader_subject: None,
            details: json!({"row_count": units.items.len()}),
        },
        &[],
    )
    .await?;
    respond(&units)
}

pub(crate) async fn get_org_unit(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_read(&p)?;
    let unit = s.store.get_org_unit(id).await.map_err(RestError::store)?;
    let mut employees: Vec<_> = unit
        .members
        .items
        .iter()
        .map(|m| m.employee_id)
        .chain(unit.revisions.iter().filter_map(|r| r.head_employee_id))
        .collect();
    employees.sort_unstable();
    employees.dedup();
    let mut users: Vec<_> = unit.revisions.iter().map(|r| r.actor_id).collect();
    users.sort_unstable();
    users.dedup();
    access_log::record(
        &s,
        &p,
        AccessRecord {
            action: "org_unit.read",
            target_type: "org_unit",
            target_id: id.to_string(),
            subject_ids: &employees,
            reader_subject: None,
            details: json!({}),
        },
        &users,
    )
    .await?;
    respond(&unit)
}

pub(crate) async fn draft_create_org_unit(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Json(b): Json<CreateOrgUnitRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    let name = b.name.trim().to_owned();
    draft_org_unit_change(
        &s,
        &h,
        p.user_id,
        OrgChangeKind::New,
        OrgChangeTarget {
            kind: TargetKind::OrgUnit,
            target_ref: b.parent_id.unwrap_or(Uuid::nil()).to_string(),
            label: name.clone(),
        },
        "Create org unit",
        vec![OrgProposalOp::CreateOrgUnit {
            kind: b.kind,
            parent_id: b.parent_id,
            name,
        }],
    )
    .await
}

pub(crate) async fn draft_update_org_unit(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<UpdateOrgUnitRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    let name = b.name.map(|name| name.trim().to_owned());
    let mut proposal = Vec::new();
    if let Some(name) = name.clone() {
        proposal.push(OrgProposalOp::RenameOrgUnit {
            org_unit_id: id,
            name,
        });
    }
    if let Some(parent_id) = b.parent_id {
        proposal.push(OrgProposalOp::MoveOrgUnit {
            org_unit_id: id,
            parent_id,
        });
    }
    if proposal.is_empty() {
        return Err(RestError::kernel(KernelError::validation(
            "name and/or parentId is required",
        )));
    }
    draft_org_unit_change(
        &s,
        &h,
        p.user_id,
        OrgChangeKind::Reorg,
        OrgChangeTarget {
            kind: TargetKind::OrgUnit,
            target_ref: id.to_string(),
            label: name.unwrap_or_else(|| format!("OrgUnit {id}")),
        },
        "Update org unit",
        proposal,
    )
    .await
}

pub(crate) async fn draft_dissolve_org_unit(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    draft_org_unit_change(
        &s,
        &h,
        p.user_id,
        OrgChangeKind::Dissolve,
        OrgChangeTarget {
            kind: TargetKind::OrgUnit,
            target_ref: id.to_string(),
            label: format!("OrgUnit {id}"),
        },
        "Dissolve org unit",
        vec![OrgProposalOp::DissolveOrgUnit {
            org_unit_id: id,
            merged_into: None,
        }],
    )
    .await
}

/// One DRAFT org change for a convenience org-unit write. Effective today
/// (KST, server-owned, kept out of the fingerprint like the legacy URLs).
pub(crate) async fn draft_org_unit_change(
    s: &OrgChangeRestState,
    h: &HeaderMap,
    actor: UserId,
    kind: OrgChangeKind,
    target: OrgChangeTarget,
    reason: &'static str,
    proposal: Vec<OrgProposalOp>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let idempotency_key = idem_header(h)?;
    let fingerprint_input = json!({
        "surface": "orgchange.org-unit",
        "kind": kind,
        "target": target,
        "reason": reason,
        "proposal": proposal,
    });
    let (detail, replayed) = s
        .store
        .create(
            actor,
            CreateOrgChange {
                kind,
                target,
                effective_date: OffsetDateTime::now_utc().to_offset(offset!(+9)).date(),
                reason: reason.to_owned(),
                proposal,
                supersedes_id: None,
                idempotency_key,
                fingerprint_input,
            },
        )
        .await
        .map_err(RestError::store)?;
    let status = if replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    respond(&detail).map(|body| (status, body))
}

pub(crate) fn conceal_out_of_scope_branch(p: &Principal, id: Uuid) -> Result<(), RestError> {
    if p.branch_scope.allows(BranchId::from_uuid(id)) {
        Ok(())
    } else {
        Err(RestError::kernel(KernelError::not_found(
            "branch was not found",
        )))
    }
}
