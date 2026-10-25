use crate::*;

#[allow(clippy::too_many_arguments)] // + the tenant, for the Company-root parent id
pub(crate) async fn compute_preflight(
    tx: Tx<'_, '_>,
    org: OrgId,
    kind: OrgChangeKind,
    target: &OrgChangeTarget,
    proposal: &[OrgProposalOp],
    effective_date: Date,
    now: OffsetDateTime,
) -> Result<PreflightReport, PgOrgChangeError> {
    // A draft stored before decisions #18 may still hold a retired op.
    refuse_retired(proposal)?;
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let mut restrict_dependents: Vec<Dependent> = Vec::new();
    let mut dependents_total: i64 = 0;

    // Proposal targets can disappear or become unusable after a DRAFT is
    // written. Re-check them on every preflight/submit so an approval chain is
    // never spent on a request that apply already knows it cannot effectuate.
    // Requirements are coalesced by UUID; Active dominates Exists when several
    // ops refer to the same row.
    let (region_requirements, branch_requirements) = org_unit_requirements(proposal);
    let mut unavailable_regions = Vec::new();
    for (region_id, required) in region_requirements {
        let row: Option<(Option<OffsetDateTime>,)> =
            sqlx::query_as("SELECT deactivated_at FROM regions WHERE id = $1")
                .bind(region_id)
                .fetch_optional(tx.as_mut())
                .await?;
        let available = row.is_some_and(|(deactivated_at,)| {
            required == RequiredTargetState::Exists || deactivated_at.is_none()
        });
        if !available {
            unavailable_regions.push(region_id);
        }
    }
    let mut unavailable_branches = Vec::new();
    for (branch_id, required) in branch_requirements {
        let row: Option<(Option<OffsetDateTime>,)> =
            sqlx::query_as("SELECT deactivated_at FROM branches WHERE id = $1")
                .bind(branch_id)
                .fetch_optional(tx.as_mut())
                .await?;
        let available = row.is_some_and(|(deactivated_at,)| {
            required == RequiredTargetState::Exists || deactivated_at.is_none()
        });
        if !available {
            unavailable_branches.push(branch_id);
        }
    }
    if !unavailable_regions.is_empty() {
        let count = i64::try_from(unavailable_regions.len()).unwrap_or(i64::MAX);
        blockers.push(PreflightBlocker {
            code: "REGION_TARGET_UNAVAILABLE".to_owned(),
            label: "대상 지역을 찾을 수 없거나 비활성 상태입니다.".to_owned(),
            dependent_kind: "region".to_owned(),
            count,
        });
        dependents_total += count;
        restrict_dependents.extend(unavailable_regions.into_iter().map(|id| Dependent {
            kind: "region".to_owned(),
            id: id.to_string(),
            on_delete: OnDelete::Restrict,
        }));
    }
    if !unavailable_branches.is_empty() {
        let count = i64::try_from(unavailable_branches.len()).unwrap_or(i64::MAX);
        blockers.push(PreflightBlocker {
            code: "BRANCH_TARGET_UNAVAILABLE".to_owned(),
            label: "대상 지점을 찾을 수 없거나 비활성 상태입니다.".to_owned(),
            dependent_kind: "branch".to_owned(),
            count,
        });
        dependents_total += count;
        restrict_dependents.extend(unavailable_branches.into_iter().map(|id| Dependent {
            kind: "branch".to_owned(),
            id: id.to_string(),
            on_delete: OnDelete::Restrict,
        }));
    }

    // Restrict-dependent scan per deactivation op — the same guards the
    // identity referential nets enforce at apply time, surfaced early.
    for op in proposal {
        match op {
            OrgProposalOp::DeactivateBranch { branch_id } => {
                let users = count_by_uuid(
                    tx,
                    "SELECT count(*) FROM user_branches ub \
                     JOIN users u ON u.id = ub.user_id \
                     WHERE ub.branch_id = $1 AND u.is_active = true",
                    *branch_id,
                )
                .await?;
                let equipment = count_by_uuid(
                    tx,
                    "SELECT count(*) FROM registry_equipment \
                     WHERE branch_id = $1 AND status NOT IN ('폐기', '매각')",
                    *branch_id,
                )
                .await?;
                push_dependent(
                    kind,
                    &mut blockers,
                    &mut warnings,
                    &mut restrict_dependents,
                    "ACTIVE_USERS",
                    "활성 사용자 재배정 필요",
                    "user",
                    branch_id.to_string(),
                    users,
                );
                push_dependent(
                    kind,
                    &mut blockers,
                    &mut warnings,
                    &mut restrict_dependents,
                    "ACTIVE_EQUIPMENT",
                    "장비 이동·폐기·매각 처리 필요",
                    "equipment",
                    branch_id.to_string(),
                    equipment,
                );
                dependents_total += users + equipment;
            }
            OrgProposalOp::DeactivateRegion { region_id } => {
                let branches = count_by_uuid(
                    tx,
                    "SELECT count(*) FROM branches \
                     WHERE region_id = $1 AND deactivated_at IS NULL",
                    *region_id,
                )
                .await?;
                push_dependent(
                    kind,
                    &mut blockers,
                    &mut warnings,
                    &mut restrict_dependents,
                    "ACTIVE_BRANCHES",
                    "활성 지점 비활성화·이동 필요",
                    "branch",
                    region_id.to_string(),
                    branches,
                );
                dependents_total += branches;
            }
            _ => {}
        }
    }

    dependents_total +=
        org_unit_preflight(tx, org, proposal, &mut blockers, &mut restrict_dependents).await?;

    let scoped_people = scope_headcount(tx, target).await?;
    // A unit's members are the org-unit preflight's (a blocker unless an op
    // of the change moves them); a legacy branch/region dissolve still warns.
    if kind == OrgChangeKind::Dissolve && scoped_people > 0 && target.kind != TargetKind::OrgUnit {
        // The apply re-verifies in-transaction and refuses while they remain.
        warnings.push(PreflightWarning {
            code: "EMPLOYEES_SETTLEMENT".to_owned(),
            label: "소속 직원 전보·전적 정산 필요".to_owned(),
            dependent_kind: Some("employee".to_owned()),
            count: Some(scoped_people),
        });
        dependents_total += scoped_people;
    }

    // No uncomputed reminder chips (UX-R2 org-05): 공고, positions, cost
    // centres and assets do not exist here, and 결재 is off by default (#26).
    // §3.9.1 동결 창 — computed, not a reminder: literally the read
    // `assert_change_window_open` enforces at apply time, so the chip and the
    // refusal can never disagree. Surfaced early so the approval chain is not
    // spent on a change effectuate would refuse. It stays a warning rather than
    // a blocker because a lock can be lifted before the effective date arrives;
    // the hard stop lives at effectuate.
    let mut frozen = Vec::new();
    for domain in FREEZE_DOMAINS {
        match assert_period_open(tx, domain, effective_date).await {
            Ok(()) => {}
            Err(refusal) if refusal.kind == ErrorKind::Conflict => {
                frozen.push(freeze_domain_label(domain));
            }
            Err(other) => return Err(other.into()),
        }
    }
    // One chip however many domains block: the console keys this list by `code`
    // (`web/src/console/org/OrgChangeModal.tsx`), so a second row under the same
    // code is a duplicate React key, not a second signal.
    if !frozen.is_empty() {
        warnings.push(PreflightWarning {
            code: "FREEZE_WINDOW_REVIEW".to_owned(),
            label: format!("{} 동결 — 발효일 조정 필요", frozen.join("·")),
            dependent_kind: None,
            count: None,
        });
    }

    // Governance verdict: Restrict dependents ⇒ deny (arch §15).
    let impact = assess_impact(restrict_dependents);
    if impact.allow != blockers.is_empty() {
        return Err(KernelError::internal("impact assessment disagrees with blocker scan").into());
    }

    Ok(PreflightReport {
        computed_at: now,
        stale: false,
        blockers,
        warnings,
        // The rolled-back proposal replay computes the people it actually changes.
        headcount: 0,
        dependents_total,
    })
}
