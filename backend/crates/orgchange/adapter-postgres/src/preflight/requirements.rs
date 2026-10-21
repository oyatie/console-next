use crate::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum RequiredTargetState {
    Exists,
    Active,
}

pub(crate) fn require_target_state(
    requirements: &mut BTreeMap<Uuid, RequiredTargetState>,
    id: Uuid,
    required: RequiredTargetState,
) {
    requirements
        .entry(id)
        .and_modify(|current| *current = (*current).max(required))
        .or_insert(required);
}

pub(crate) fn org_unit_requirements(
    proposal: &[OrgProposalOp],
) -> (
    BTreeMap<Uuid, RequiredTargetState>,
    BTreeMap<Uuid, RequiredTargetState>,
) {
    let mut regions = BTreeMap::new();
    let mut branches = BTreeMap::new();
    for op in proposal {
        match op {
            OrgProposalOp::CreateRegion { .. } => {}
            OrgProposalOp::RenameRegion { region_id, .. } => {
                require_target_state(&mut regions, *region_id, RequiredTargetState::Exists);
            }
            OrgProposalOp::DeactivateRegion { region_id }
            | OrgProposalOp::CreateBranch { region_id, .. } => {
                require_target_state(&mut regions, *region_id, RequiredTargetState::Active);
            }
            OrgProposalOp::RenameBranch {
                branch_id,
                region_id,
                ..
            } => {
                require_target_state(&mut branches, *branch_id, RequiredTargetState::Exists);
                if let Some(region_id) = region_id {
                    require_target_state(&mut regions, *region_id, RequiredTargetState::Active);
                }
            }
            OrgProposalOp::DeactivateBranch { branch_id } => {
                require_target_state(&mut branches, *branch_id, RequiredTargetState::Active);
            }
            OrgProposalOp::CreateSite { .. }
            | OrgProposalOp::UpdateSite { .. }
            | OrgProposalOp::ReassignOrgUnit { .. }
            | OrgProposalOp::CreateOrgUnit { .. }
            | OrgProposalOp::RenameOrgUnit { .. }
            | OrgProposalOp::MoveOrgUnit { .. }
            | OrgProposalOp::DissolveOrgUnit { .. } => {}
        }
    }
    (regions, branches)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn push_dependent(
    kind: OrgChangeKind,
    blockers: &mut Vec<PreflightBlocker>,
    warnings: &mut Vec<PreflightWarning>,
    restrict: &mut Vec<Dependent>,
    code: &str,
    label: &str,
    dependent_kind: &str,
    dependent_id: String,
    count: i64,
) {
    if count == 0 {
        return;
    }
    if kind == OrgChangeKind::Dissolve {
        // Dissolve resolves dependents during 정산; archive re-verifies.
        warnings.push(PreflightWarning {
            code: code.to_owned(),
            label: label.to_owned(),
            dependent_kind: Some(dependent_kind.to_owned()),
            count: Some(count),
        });
    } else {
        blockers.push(PreflightBlocker {
            code: code.to_owned(),
            label: label.to_owned(),
            dependent_kind: dependent_kind.to_owned(),
            count,
        });
        restrict.push(Dependent {
            kind: dependent_kind.to_owned(),
            id: dependent_id,
            on_delete: OnDelete::Restrict,
        });
    }
}

pub(crate) async fn store_preflight(
    tx: Tx<'_, '_>,
    id: Uuid,
    report: &PreflightReport,
    status: OrgChangeStatus,
    site_count: i64,
    team_count: i64,
    now: OffsetDateTime,
) -> Result<(), PgOrgChangeError> {
    let receipt = serde_json::to_value(report)
        .map_err(|_| KernelError::internal("preflight receipt serialization failed"))?;
    sqlx::query(
        "UPDATE org_change_requests SET preflight = $2, headcount = $3, site_count = $4, \
         team_count = $5, status = $6, updated_at = $7 WHERE id = $1",
    )
    .bind(id)
    .bind(receipt)
    .bind(report.headcount)
    .bind(site_count)
    .bind(team_count)
    .bind(status.as_db())
    .bind(now)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
