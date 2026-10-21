use crate::{PlatformProvisioner, ProvisioningError};
use console_kernel_core::{AuditAction, AuditEvent, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;

impl PlatformProvisioner {
    pub async fn company_domain_available_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: UserId,
        slug: &str,
        now: OffsetDateTime,
    ) -> Result<bool, ProvisioningError> {
        let available: bool = sqlx::query_scalar("SELECT platform_company_domain_available($1)")
            .bind(slug)
            .fetch_one(tx.as_mut())
            .await?;
        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("platform.tenant.domain.check")?,
            "organizations",
            "domain",
            TraceContext::generate(),
            now,
        );
        insert_audit_event(tx, &event).await?;
        Ok(available)
    }
}

impl PlatformProvisioner {
    pub async fn request_company_domain(
        &self,
        pool: &sqlx::PgPool,
        actor: UserId,
        org: console_kernel_core::OrgId,
        slug: &str,
        key: &str,
        now: OffsetDateTime,
    ) -> Result<(), ProvisioningError> {
        let mut tx = begin_domain_request(pool, actor, org).await?;
        use console_platform_db::idempotency::{
            IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
        };
        let input = serde_json::json!({"actor":actor, "slug":slug});
        match claim_idempotency_key(&mut tx, "tenant.domain.request", key, &input).await? {
            IdempotencyClaim::Replay(_) => {
                tx.commit().await?;
                return Ok(());
            }
            IdempotencyClaim::Mismatch => {
                return Err(ProvisioningError::Conflict(
                    console_platform_db::idempotency::IDEMPOTENCY_KEY_REUSED.into(),
                ));
            }
            IdempotencyClaim::Fresh => {}
        }
        let current: Option<String> =
            sqlx::query_scalar("SELECT slug FROM platform_lock_organization($1)")
                .bind(org.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
        if current.as_deref() == Some(slug)
            || console_platform_auth::normalize_company_domain(slug).as_deref() != Some(slug)
        {
            return Err(ProvisioningError::SlugInvalid(
                "invalid requested company domain".into(),
            ));
        }
        let available: bool = sqlx::query_scalar("SELECT platform_company_domain_available($1)")
            .bind(slug)
            .fetch_one(tx.as_mut())
            .await?;
        if !available {
            return Err(ProvisioningError::SlugTaken);
        }
        sqlx::query("INSERT INTO organization_domain_requests (org_id,slug,requested_by,requested_at) VALUES ($1,$2,$3,$4) \
            ON CONFLICT(org_id) DO UPDATE SET slug=excluded.slug, requested_by=excluded.requested_by, requested_at=excluded.requested_at, resolved_at=NULL")
            .bind(org.as_uuid()).bind(slug).bind(actor.as_uuid()).bind(now).execute(tx.as_mut()).await?;
        let audit = AuditEvent::new(
            Some(actor),
            AuditAction::new("tenant.domain.request")?,
            "organizations",
            org.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(org)
        .with_snapshots(None, Some(serde_json::json!({"requested_domain":slug})));
        insert_audit_event(&mut tx, &audit).await?;
        complete_idempotency_key(
            &mut tx,
            "tenant.domain.request",
            key,
            &serde_json::json!({"pending_domain":slug}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

impl PlatformProvisioner {
    pub async fn own_company_domain_request(
        &self,
        pool: &sqlx::PgPool,
        actor: UserId,
        org: console_kernel_core::OrgId,
    ) -> Result<Option<String>, ProvisioningError> {
        let mut tx = begin_domain_request(pool, actor, org).await?;
        let pending = sqlx::query_scalar("SELECT slug FROM organization_domain_requests WHERE org_id=$1 AND requested_by=$2 AND resolved_at IS NULL")
            .bind(org.as_uuid()).bind(actor.as_uuid()).fetch_optional(tx.as_mut()).await?;
        let audit = AuditEvent::new(
            Some(actor),
            AuditAction::new("tenant.domain.request.read")?,
            "organizations",
            org.to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(org);
        insert_audit_event(&mut tx, &audit).await?;
        tx.commit().await?;
        Ok(pending)
    }
}

async fn begin_domain_request(
    pool: &sqlx::PgPool,
    actor: UserId,
    org: console_kernel_core::OrgId,
) -> Result<Transaction<'static, Postgres>, ProvisioningError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await?;
    console_platform_auth::lock_account_tx(&mut tx, org, *actor.as_uuid()).await?;
    let tenant_ops: Option<bool> = sqlx::query_scalar(
        "SELECT is_tenant_ops AND is_active FROM users WHERE id=$1 AND org_id=$2",
    )
    .bind(actor.as_uuid())
    .bind(org.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    if !console_platform_authz::cedar_pbac::actions::company_domain_request::decide(
        &actor.to_string(),
        &org.to_string(),
        &org.to_string(),
        tenant_ops == Some(true),
    ) {
        return Err(ProvisioningError::DomainRequestForbidden);
    }
    sqlx::query("SELECT slug FROM platform_lock_organization($1)")
        .bind(org.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?;
    Ok(tx)
}
