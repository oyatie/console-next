//! MR-21: change a tenant's name and/or slug (decisions #21 req. 1).

use crate::error::map_org_write_error;
use crate::{OrganizationSummary, PlatformProvisioner, ProvisioningError, fetch_org_tx};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

pub struct TenantRename<'a> {
    pub slug: Option<&'a str>,
    pub name: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
}

impl PlatformProvisioner {
    /// Rename a tenant. `None` keeps a field; at least one is required. Runs via
    /// the SECURITY DEFINER `platform_rename_organization` (0261), which never
    /// touches the platform sentinel. Audited to the TARGET org with the before
    /// and after values (`platform.tenant.rename`).
    ///
    /// # Errors
    /// `InvalidRoster` (nothing to change, empty name), `SlugTaken`, `SlugInvalid`,
    /// `NotFound`, or database faults.
    pub async fn rename_tenant(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        org_id: Uuid,
        slug: Option<&str>,
        name: Option<&str>,
        now: OffsetDateTime,
    ) -> Result<OrganizationSummary, ProvisioningError> {
        self.rename_tenant_with_key(
            pool,
            actor,
            org_id,
            TenantRename {
                slug,
                name,
                idempotency_key: None,
            },
            now,
        )
        .await
    }

    pub async fn rename_tenant_with_key(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        org_id: Uuid,
        input: TenantRename<'_>,
        now: OffsetDateTime,
    ) -> Result<OrganizationSummary, ProvisioningError> {
        let slug = input.slug.map(str::trim);
        let name = input.name.map(str::trim);
        let key = input.idempotency_key;
        if slug.is_none() && name.is_none() {
            return Err(ProvisioningError::InvalidRoster(
                "name or slug is required to rename a tenant".to_owned(),
            ));
        }
        if name == Some("") {
            return Err(ProvisioningError::InvalidRoster(
                "the tenant name must not be empty".to_owned(),
            ));
        }

        let mut tx = pool.begin().await?;
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org_id.to_string())
            .execute(tx.as_mut())
            .await?;
        // Account owners finish their company FK writes before the slug's exclusive lock.
        let accounts: Vec<Uuid> = if slug.is_some() {
            sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 ORDER BY id FOR NO KEY UPDATE")
                .bind(org_id)
                .fetch_all(tx.as_mut())
                .await?
        } else {
            Vec::new()
        };
        let before: Option<(String, String)> =
            sqlx::query_as("SELECT slug, name FROM platform_lock_organization($1)")
                .bind(org_id)
                .fetch_optional(tx.as_mut())
                .await?;
        if before.is_none() {
            return Err(ProvisioningError::NotFound("tenant not found".into()));
        }
        let input = serde_json::json!({"actor":actor, "slug":slug, "name":name});
        if let Some(key) = key {
            use console_platform_db::idempotency::{IdempotencyClaim, claim_idempotency_key};
            match claim_idempotency_key(&mut tx, "platform.tenant.rename", key, &input).await? {
                IdempotencyClaim::Replay(body) => {
                    let organization = serde_json::from_value(body)?;
                    tx.commit().await?;
                    return Ok(organization);
                }
                IdempotencyClaim::Mismatch => {
                    return Err(ProvisioningError::Conflict(
                        console_platform_db::idempotency::IDEMPOTENCY_KEY_REUSED.into(),
                    ));
                }
                IdempotencyClaim::Fresh => {}
            }
        }
        if slug.is_some() {
            let current: Vec<Uuid> =
                sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 ORDER BY id")
                    .bind(org_id)
                    .fetch_all(tx.as_mut())
                    .await?;
            if current != accounts {
                return Err(ProvisioningError::Conflict(
                    "tenant accounts changed; retry the domain command".into(),
                ));
            }
        }
        let updated: Option<Uuid> =
            sqlx::query_scalar("SELECT platform_rename_organization($1, $2, $3, $4, $5)")
                .bind(org_id)
                .bind(slug)
                .bind(name)
                .bind(now)
                .bind(now + Duration::days(console_platform_auth::SIGN_IN_ALIAS_DAYS))
                .fetch_one(tx.as_mut())
                .await
                .map_err(map_org_write_error)?;
        let (Some(updated_id), Some((old_slug, old_name))) = (updated, before) else {
            tx.rollback().await?;
            return Err(ProvisioningError::NotFound("tenant not found".to_owned()));
        };
        let mut organization = fetch_org_tx(&mut tx, updated_id).await?;

        if old_slug != organization.slug {
            sqlx::query(
                "INSERT INTO notifications (org_id, recipient_user_id, category, body, link) \
                 SELECT org_id, id, 'tenant.domain.change', $2, \
                        jsonb_build_object('type', 'screen', 'screen', 'settings/company-domain') FROM users WHERE org_id = $1",
            )
            .bind(org_id)
            .bind(crate::catalog::company_domain_changed(&old_slug, &organization.slug))
            .execute(tx.as_mut())
            .await?;
        }
        let fulfilled = sqlx::query("UPDATE organization_domain_requests SET resolved_at=$2 WHERE org_id=$1 AND slug=$3 AND resolved_at IS NULL")
            .bind(org_id).bind(now).bind(&organization.slug).execute(tx.as_mut()).await?.rows_affected();
        if fulfilled > 0 {
            organization.pending_domain = None;
        }
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.rename")?,
            "organizations",
            org_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id))
        .with_snapshots(
            Some(serde_json::json!({ "slug": old_slug, "name": old_name })),
            Some(serde_json::json!({ "slug": organization.slug, "name": organization.name })),
        );
        insert_audit_event(&mut tx, &event).await?;

        if let Some(key) = key {
            console_platform_db::idempotency::complete_idempotency_key(
                &mut tx,
                "platform.tenant.rename",
                key,
                &serde_json::to_value(&organization)?,
            )
            .await?;
        }
        tx.commit().await?;
        Ok(organization)
    }
}
