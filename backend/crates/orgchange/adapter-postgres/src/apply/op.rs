use crate::*;

pub(crate) async fn apply_op(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    command_id: Uuid,
    op: &OrgProposalOp,
    now: OffsetDateTime,
) -> Result<AuditEvent, PgOrgChangeError> {
    let (target_kind, target_id) = match op {
        OrgProposalOp::CreateRegion { name } => {
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO regions (id, name, created_at, org_id) VALUES ($1, $2, $3, $4)",
            )
            .bind(id)
            .bind(name)
            .bind(now)
            .bind(*org.as_uuid())
            .execute(tx.as_mut())
            .await?;
            emit_region_or_branch_binding(
                tx,
                org,
                actor,
                command_id,
                org_unit_binding::SOURCE_KIND_REGION,
                id,
                name,
            )
            .await?;
            ("region", id)
        }
        OrgProposalOp::RenameRegion { region_id, name } => {
            let changed = sqlx::query("UPDATE regions SET name = $2 WHERE id = $1")
                .bind(region_id)
                .bind(name)
                .execute(tx.as_mut())
                .await?
                .rows_affected();
            if changed != 1 {
                return Err(KernelError::conflict("region was not found").into());
            }
            ("region", *region_id)
        }
        OrgProposalOp::DeactivateRegion { region_id } => {
            let row: Option<(Uuid, Option<OffsetDateTime>)> =
                sqlx::query_as("SELECT id, deactivated_at FROM regions WHERE id = $1 FOR UPDATE")
                    .bind(region_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
            let Some((_, deactivated_at)) = row else {
                return Err(KernelError::conflict("region was not found").into());
            };
            if deactivated_at.is_some() {
                return Err(KernelError::conflict("region is already deactivated").into());
            }
            let active: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM branches WHERE region_id = $1 AND deactivated_at IS NULL",
            )
            .bind(region_id)
            .fetch_one(tx.as_mut())
            .await?;
            if active > 0 {
                return Err(
                    KernelError::conflict("active branches remain under the region").into(),
                );
            }
            sqlx::query("UPDATE regions SET deactivated_at = $2 WHERE id = $1")
                .bind(region_id)
                .bind(now)
                .execute(tx.as_mut())
                .await?;
            ("region", *region_id)
        }
        OrgProposalOp::CreateBranch { region_id, name } => {
            // Inverse of DeactivateRegion's active-branch guard (console-k6wm /
            // identity lx6 sibling): refuse assigning a live branch under a
            // soft-deleted region that list_regions hides.
            require_active_region_tx(tx, *region_id).await?;
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO branches (id, region_id, name, created_at, org_id) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(id)
            .bind(region_id)
            .bind(name)
            .bind(now)
            .bind(*org.as_uuid())
            .execute(tx.as_mut())
            .await?;
            emit_region_or_branch_binding(
                tx,
                org,
                actor,
                command_id,
                org_unit_binding::SOURCE_KIND_BRANCH,
                id,
                name,
            )
            .await?;
            ("branch", id)
        }
        OrgProposalOp::RenameBranch {
            branch_id,
            name,
            region_id,
        } => {
            let exists: Option<Uuid> =
                sqlx::query_scalar("SELECT id FROM branches WHERE id = $1 FOR UPDATE")
                    .bind(branch_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
            if exists.is_none() {
                return Err(KernelError::conflict("branch was not found").into());
            }
            if let Some(region_id) = region_id {
                require_active_region_tx(tx, *region_id).await?;
                sqlx::query("UPDATE branches SET region_id = $2 WHERE id = $1")
                    .bind(branch_id)
                    .bind(region_id)
                    .execute(tx.as_mut())
                    .await?;
            }
            if let Some(name) = name {
                sqlx::query("UPDATE branches SET name = $2 WHERE id = $1")
                    .bind(branch_id)
                    .bind(name)
                    .execute(tx.as_mut())
                    .await?;
            }
            ("branch", *branch_id)
        }
        OrgProposalOp::DeactivateBranch { branch_id } => {
            let row: Option<(Uuid, Option<OffsetDateTime>)> =
                sqlx::query_as("SELECT id, deactivated_at FROM branches WHERE id = $1 FOR UPDATE")
                    .bind(branch_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
            let Some((_, deactivated_at)) = row else {
                return Err(KernelError::conflict("branch was not found").into());
            };
            if deactivated_at.is_some() {
                return Err(KernelError::conflict("branch is already deactivated").into());
            }
            crate::legacy_setup::refuse_branch_backing_workplace(tx, *branch_id).await?;
            let users: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM user_branches ub JOIN users u ON u.id = ub.user_id \
                 WHERE ub.branch_id = $1 AND u.is_active = true",
            )
            .bind(branch_id)
            .fetch_one(tx.as_mut())
            .await?;
            if users > 0 {
                return Err(
                    KernelError::conflict("active users are still assigned to the branch").into(),
                );
            }
            let equipment: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM registry_equipment \
                 WHERE branch_id = $1 AND status NOT IN ('폐기', '매각')",
            )
            .bind(branch_id)
            .fetch_one(tx.as_mut())
            .await?;
            if equipment > 0 {
                return Err(
                    KernelError::conflict("non-terminal equipment remains in the branch").into(),
                );
            }
            sqlx::query("UPDATE branches SET deactivated_at = $2 WHERE id = $1")
                .bind(branch_id)
                .bind(now)
                .execute(tx.as_mut())
                .await?;
            ("branch", *branch_id)
        }
        OrgProposalOp::CreateSite { customer_id, name } => {
            let branch: Option<Uuid> =
                sqlx::query_scalar("SELECT branch_id FROM registry_customers WHERE id = $1")
                    .bind(customer_id)
                    .fetch_optional(tx.as_mut())
                    .await?;
            let Some(branch) = branch else {
                return Err(KernelError::conflict("customer was not found").into());
            };
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO registry_sites (id, branch_id, customer_id, name, org_id) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(id)
            .bind(branch)
            .bind(customer_id)
            .bind(name)
            .bind(*org.as_uuid())
            .execute(tx.as_mut())
            .await?;
            ("site", id)
        }
        OrgProposalOp::UpdateSite { site_id, name } => {
            let changed =
                sqlx::query("UPDATE registry_sites SET name = $2, updated_at = $3 WHERE id = $1")
                    .bind(site_id)
                    .bind(name)
                    .bind(now)
                    .execute(tx.as_mut())
                    .await?
                    .rows_affected();
            if changed != 1 {
                return Err(KernelError::conflict("site was not found").into());
            }
            ("site", *site_id)
        }
        OrgProposalOp::CreateOrgUnit { .. }
        | OrgProposalOp::RenameOrgUnit { .. }
        | OrgProposalOp::MoveOrgUnit { .. }
        | OrgProposalOp::DissolveOrgUnit { .. }
        | OrgProposalOp::ReassignOrgUnit { .. } => {
            return Err(KernelError::internal(
                "org-unit and reassign ops apply through apply_ops' own arms",
            )
            .into());
        }
    };
    Ok(audit(
        org,
        actor,
        "org_change.apply.op",
        target_kind,
        target_id.to_string(),
        now,
    )?)
}
