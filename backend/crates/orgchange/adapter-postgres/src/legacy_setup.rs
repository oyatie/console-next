use crate::*;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// Restore the target-state contract of the legacy region/branch mutators
/// while they act as governed proposal inputs. The caller invokes this only
/// after resolving an idempotent replay, so a valid retry remains a replay even
/// when the live target changed after the original DRAFT was accepted.
pub(crate) async fn validate_legacy_org_setup_targets(
    tx: Tx<'_, '_>,
    proposal: &[OrgProposalOp],
) -> Result<(), PgOrgChangeError> {
    let [op] = proposal else {
        return Err(KernelError::validation(
            "legacy org-setup proposals must contain exactly one operation",
        )
        .into());
    };
    match op {
        OrgProposalOp::CreateRegion { .. } => Ok(()),
        OrgProposalOp::RenameRegion { region_id, .. } => {
            let exists: Option<Uuid> =
                sqlx::query_scalar("SELECT id FROM regions WHERE id = $1 FOR UPDATE")
                    .bind(region_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
            if exists.is_none() {
                return Err(KernelError::not_found("region not found").into());
            }
            Ok(())
        }
        OrgProposalOp::DeactivateRegion { region_id } => {
            let row: Option<(Uuid, Option<OffsetDateTime>)> =
                sqlx::query_as("SELECT id, deactivated_at FROM regions WHERE id = $1 FOR UPDATE")
                    .bind(region_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
            let Some((_, deactivated_at)) = row else {
                return Err(KernelError::not_found("region not found").into());
            };
            if deactivated_at.is_some() {
                return Err(KernelError::conflict("이미 비활성화된 지역입니다.").into());
            }
            Ok(())
        }
        OrgProposalOp::CreateBranch { region_id, .. } => {
            validate_legacy_destination_region(tx, *region_id).await
        }
        OrgProposalOp::RenameBranch {
            branch_id,
            region_id,
            ..
        } => {
            let exists: Option<Uuid> =
                sqlx::query_scalar("SELECT id FROM branches WHERE id = $1 FOR UPDATE")
                    .bind(branch_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
            if exists.is_none() {
                return Err(KernelError::not_found("branch not found").into());
            }
            if let Some(region_id) = region_id {
                validate_legacy_destination_region(tx, *region_id).await?;
            }
            Ok(())
        }
        OrgProposalOp::DeactivateBranch { branch_id } => {
            let row: Option<(Uuid, Option<OffsetDateTime>)> =
                sqlx::query_as("SELECT id, deactivated_at FROM branches WHERE id = $1 FOR UPDATE")
                    .bind(branch_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
            let Some((_, deactivated_at)) = row else {
                return Err(KernelError::not_found("branch not found").into());
            };
            if deactivated_at.is_some() {
                return Err(KernelError::conflict("이미 비활성화된 지점입니다.").into());
            }
            refuse_branch_backing_workplace(tx, *branch_id).await
        }
        OrgProposalOp::CreateSite { .. }
        | OrgProposalOp::UpdateSite { .. }
        | OrgProposalOp::ReassignOrgUnit { .. }
        | OrgProposalOp::CreateOrgUnit { .. }
        | OrgProposalOp::RenameOrgUnit { .. }
        | OrgProposalOp::MoveOrgUnit { .. }
        | OrgProposalOp::DissolveOrgUnit { .. } => Err(KernelError::validation(
            "legacy org-setup proposals only accept region or branch operations",
        )
        .into()),
    }
}

/// Refuse closing a branch that backs a live 사업장 (decisions #18): the
/// branch is the 사업장's authorization spine and closes with it.
pub(crate) async fn refuse_branch_backing_workplace(
    tx: Tx<'_, '_>,
    branch_id: Uuid,
) -> Result<(), PgOrgChangeError> {
    let backs: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM workplaces WHERE default_branch_id = $1 AND voided_at IS NULL)",
    )
    .bind(branch_id)
    .fetch_one(tx.as_mut())
    .await?;
    if backs {
        return Err(KernelError::conflict(
            "the branch backs a workplace: close the workplace instead",
        )
        .with_code(BRANCH_BACKS_WORKPLACE)
        .into());
    }
    Ok(())
}

pub(crate) async fn validate_legacy_destination_region(
    tx: Tx<'_, '_>,
    region_id: Uuid,
) -> Result<(), PgOrgChangeError> {
    let row: Option<(Uuid, Option<OffsetDateTime>)> =
        sqlx::query_as("SELECT id, deactivated_at FROM regions WHERE id = $1 FOR UPDATE")
            .bind(region_id)
            .fetch_optional(tx.as_mut())
            .await?;
    let Some((_, deactivated_at)) = row else {
        return Err(KernelError::not_found("region not found").into());
    };
    if deactivated_at.is_some() {
        return Err(KernelError::conflict(
            "비활성화된 지역에는 지점을 추가하거나 이동할 수 없습니다.",
        )
        .into());
    }
    Ok(())
}
