use crate::*;

/// Headcount, everywhere this adapter counts people (preflight impact, the
/// dissolve blocker, the org tree and unit detail): employees who are not
/// EXITED — ACTIVE, ON_LEAVE (휴직: employed, still assigned to the unit) and
/// UNKNOWN. One predicate, `entity_employed_on(entity_today(), hire_on, exit_on, employment_status)`, shared with the
/// `ReassignOrgUnit` transfer set, so every member that blocks a dissolve is one
/// a reassign can move.
pub(crate) async fn scope_headcount(
    tx: Tx<'_, '_>,
    target: &OrgChangeTarget,
) -> Result<i64, PgOrgChangeError> {
    let count = match target.kind {
        TargetKind::Entity => {
            count_by_text(
                tx,
                "SELECT count(*) FROM employees \
                 WHERE company = $1 AND entity_employed_on(entity_today(), hire_on, exit_on, employment_status)",
                &target.label,
            )
            .await?
        }
        TargetKind::OrgUnit => {
            count_by_text(
                tx,
                "SELECT count(*) FROM employees \
                 WHERE (org_unit_id::text = $1 OR org_unit = $1) \
                   AND entity_employed_on(entity_today(), hire_on, exit_on, employment_status)",
                &target.target_ref,
            )
            .await?
        }
        TargetKind::Branch => {
            let branch = parse_ref_uuid(target)?;
            count_by_uuid(
                tx,
                "SELECT count(*) FROM employees \
                 WHERE home_branch_id = $1 AND entity_employed_on(entity_today(), hire_on, exit_on, employment_status)",
                branch,
            )
            .await?
        }
        TargetKind::Region => {
            let region = parse_ref_uuid(target)?;
            count_by_uuid(
                tx,
                "SELECT count(*) FROM employees \
                 WHERE entity_employed_on(entity_today(), hire_on, exit_on, employment_status) AND home_branch_id IN \
                 (SELECT id FROM branches WHERE region_id = $1)",
                region,
            )
            .await?
        }
        // Customer sites carry no employees; an honest zero, never a guess.
        TargetKind::Site => 0,
    };
    Ok(count)
}

pub(crate) fn parse_ref_uuid(target: &OrgChangeTarget) -> Result<Uuid, PgOrgChangeError> {
    Uuid::parse_str(&target.target_ref).map_err(|_| {
        PgOrgChangeError::from(KernelError::validation(
            "target.ref must be a UUID for REGION/BRANCH/SITE targets",
        ))
    })
}

pub(crate) fn proposal_stats(target: &OrgChangeTarget, proposal: &[OrgProposalOp]) -> (i64, i64) {
    let mut sites: i64 = i64::from(target.kind == TargetKind::Site);
    let mut teams = std::collections::BTreeSet::new();
    if target.kind == TargetKind::OrgUnit {
        teams.insert(target.target_ref.clone());
    }
    for op in proposal {
        match op {
            OrgProposalOp::CreateSite { .. } | OrgProposalOp::UpdateSite { .. } => sites += 1,
            OrgProposalOp::ReassignOrgUnit {
                from_org_unit,
                to_org_unit,
                ..
            } => {
                teams.insert(from_org_unit.clone());
                teams.insert(to_org_unit.clone());
            }
            OrgProposalOp::CreateOrgUnit { name, .. } => {
                teams.insert(format!("new:{name}"));
            }
            OrgProposalOp::RenameOrgUnit { org_unit_id, .. }
            | OrgProposalOp::MoveOrgUnit { org_unit_id, .. }
            | OrgProposalOp::DissolveOrgUnit { org_unit_id, .. } => {
                teams.insert(org_unit_id.to_string());
            }
            _ => {}
        }
    }
    (sites, i64::try_from(teams.len()).unwrap_or(i64::MAX))
}
