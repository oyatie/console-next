use crate::{
    OrganizationSummary, PlatformProvisioner, ProvisioningError, TenantHealth, fetch_org_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

impl PlatformProvisioner {
    /// List all tenants (cross-tenant read) via the SECURITY DEFINER
    /// `platform_list_organizations` so the platform tier sees every org even
    /// though `organizations` is RLS-gated for `console_rt`. Audited by the caller.
    pub async fn list_tenants(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<OrganizationSummary>, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let summaries = self.list_tenants_in_tx(&mut tx, actor, now).await?;
        tx.commit().await?;
        Ok(summaries)
    }

    /// Cross-tenant ops health rollup for EVERY tenant (audited platform read).
    ///
    /// The aggregation runs through the SECURITY DEFINER `platform_org_health()`
    /// function — the single sanctioned cross-tenant path — which scans all
    /// tenants with `row_security` briefly disabled and restored. This is a
    /// PLATFORM-tier read (org_id = NULL on the audit row) recorded as
    /// `platform.tenant.health`, so no cross-tenant read is ever unaudited.
    pub async fn list_tenant_health(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        now: OffsetDateTime,
    ) -> Result<Vec<TenantHealth>, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let health = self.list_tenant_health_in_tx(&mut tx, actor, now).await?;
        tx.commit().await?;
        Ok(health)
    }

    /// Suspend / reactivate a tenant by setting its `status`. Audited to the
    /// TARGET org. Runs via the SECURITY DEFINER `platform_set_organization_status`
    /// (organizations is not UPDATE-able by `console_rt`).
    pub async fn set_tenant_status(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        org_id: Uuid,
        status: &str,
        now: OffsetDateTime,
    ) -> Result<OrganizationSummary, ProvisioningError> {
        if !matches!(status, "ACTIVE" | "SUSPENDED" | "ARCHIVED") {
            return Err(ProvisioningError::InvalidRoster(format!(
                "invalid tenant status {status:?}"
            )));
        }

        let mut tx = pool.begin().await?;
        let updated: Option<Uuid> =
            sqlx::query_scalar("SELECT platform_set_organization_status($1, $2)")
                .bind(org_id)
                .bind(status)
                .fetch_one(tx.as_mut())
                .await?;
        let Some(updated_id) = updated else {
            tx.rollback().await?;
            return Err(ProvisioningError::NotFound("tenant not found".to_owned()));
        };
        let organization = fetch_org_tx(&mut tx, updated_id).await?;

        // Arm the TARGET org so the audit insert below passes the audit_events
        // WITH CHECK (org_id = GUC). The org row write itself went through the
        // SECURITY DEFINER function, so the GUC was not armed before now.
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(updated_id.to_string())
            .execute(tx.as_mut())
            .await?;

        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.status")?,
            "organizations",
            org_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id))
        .with_snapshots(None, Some(serde_json::json!({ "status": status })));
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(organization)
    }
}
