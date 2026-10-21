use crate::{
    GroupSummary, OrganizationSummary, PlatformProvisioner, ProvisioningError, fetch_group_tx,
    fetch_org_tx, map_group_write_error,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

impl PlatformProvisioner {
    /// List platform groups with subsidiary organization identities.
    ///
    /// This is an audited PLATFORM-tier read. It returns group topology only
    /// (group identity + member org identity) and never tenant row-level data.
    pub async fn list_groups(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<GroupSummary>, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let groups = self.list_groups_in_tx(&mut tx, actor, now).await?;
        tx.commit().await?;
        Ok(groups)
    }

    /// Create a top-level group identity (not a tenant) for subsidiary management.
    pub async fn create_group(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        slug: &str,
        name: &str,
        now: OffsetDateTime,
    ) -> Result<GroupSummary, ProvisioningError> {
        let slug = slug.trim();
        let name = name.trim();
        if slug.is_empty() || name.is_empty() {
            return Err(ProvisioningError::InvalidRoster(
                "slug and name are required to create a group".to_owned(),
            ));
        }

        let mut tx = pool.begin().await?;
        let group_id: Uuid = sqlx::query_scalar("SELECT platform_create_group($1, $2)")
            .bind(slug)
            .bind(name)
            .fetch_one(tx.as_mut())
            .await
            .map_err(map_group_write_error)?;
        let group = fetch_group_tx(&mut tx, group_id).await?;

        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.group.create")?,
            "groups",
            group_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "group_id": group_id,
                "slug": slug,
                "name": name,
            })),
        );
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(group)
    }

    /// Update group identity/status. Membership is managed by the explicit
    /// assign/remove endpoints so lifecycle and topology changes stay auditable.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_group(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        group_id: Uuid,
        slug: Option<&str>,
        name: Option<&str>,
        status: Option<&str>,
        now: OffsetDateTime,
    ) -> Result<GroupSummary, ProvisioningError> {
        let slug = slug.map(str::trim).filter(|value| !value.is_empty());
        let name = name.map(str::trim).filter(|value| !value.is_empty());
        if let Some(status) = status
            && !matches!(status, "ACTIVE" | "SUSPENDED" | "ARCHIVED")
        {
            return Err(ProvisioningError::InvalidRoster(format!(
                "invalid group status {status:?}"
            )));
        }
        if slug.is_none() && name.is_none() && status.is_none() {
            return Err(ProvisioningError::InvalidRoster(
                "at least one group field is required".to_owned(),
            ));
        }

        let mut tx = pool.begin().await?;
        let updated_id: Option<Uuid> =
            sqlx::query_scalar("SELECT platform_update_group($1, $2, $3, $4)")
                .bind(group_id)
                .bind(slug)
                .bind(name)
                .bind(status)
                .fetch_one(tx.as_mut())
                .await
                .map_err(map_group_write_error)?;
        let Some(updated_id) = updated_id else {
            tx.rollback().await?;
            return Err(ProvisioningError::NotFound("group not found".to_owned()));
        };
        let group = fetch_group_tx(&mut tx, updated_id).await?;

        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.group.update")?,
            "groups",
            group_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "group_id": group_id,
                "slug": slug,
                "name": name,
                "status": status,
            })),
        );
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(group)
    }

    /// Assign or move an organization into a group. This updates both the
    /// user-facing `organizations.group_id` identity and the owner-only
    /// `group_memberships` authorization table in one transaction.
    pub async fn assign_org_to_group(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        group_id: Uuid,
        org_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<OrganizationSummary, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let assigned_id: Option<Uuid> =
            sqlx::query_scalar("SELECT platform_assign_org_to_group($1, $2)")
                .bind(group_id)
                .bind(org_id)
                .fetch_one(tx.as_mut())
                .await
                .map_err(map_group_write_error)?;
        let Some(assigned_id) = assigned_id else {
            tx.rollback().await?;
            return Err(ProvisioningError::NotFound(
                "group or organization not found".to_owned(),
            ));
        };
        let organization = fetch_org_tx(&mut tx, assigned_id).await?;

        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_id.to_string())
            .execute(tx.as_mut())
            .await?;

        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.group.assign_org")?,
            "group_memberships",
            format!("{group_id}:{org_id}"),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id))
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "group_id": group_id,
                "org_id": org_id,
            })),
        );
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(organization)
    }

    /// Remove an organization from one group without deleting the organization.
    pub async fn remove_org_from_group(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        group_id: Uuid,
        org_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<OrganizationSummary, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let before_group_id: Option<Uuid> =
            sqlx::query_scalar::<_, Uuid>("SELECT group_id FROM platform_get_organization($1)")
                .bind(org_id)
                .fetch_optional(tx.as_mut())
                .await?;
        let removed_id: Option<Uuid> =
            sqlx::query_scalar("SELECT platform_remove_org_from_group($1, $2)")
                .bind(group_id)
                .bind(org_id)
                .fetch_one(tx.as_mut())
                .await
                .map_err(map_group_write_error)?;
        let Some(removed_id) = removed_id else {
            tx.rollback().await?;
            return Err(ProvisioningError::NotFound(
                "group or organization not found".to_owned(),
            ));
        };
        let organization = fetch_org_tx(&mut tx, removed_id).await?;

        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_id.to_string())
            .execute(tx.as_mut())
            .await?;

        let after_snap = match (before_group_id, organization.group_id) {
            (Some(before), Some(after)) if after != before => Some(serde_json::json!({
                "group_id": after,
                "org_id": org_id,
            })),
            _ => None,
        };
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.group.remove_org")?,
            "group_memberships",
            format!("{group_id}:{org_id}"),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id))
        .with_snapshots(
            Some(serde_json::json!({
                "group_id": group_id,
                "org_id": org_id,
            })),
            after_snap,
        );
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(organization)
    }
}
