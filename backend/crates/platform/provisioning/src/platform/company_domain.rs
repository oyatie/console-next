// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{PlatformProvisioner, ProvisioningError};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::company_domain_state::{begin_domain_request, load_state_in_tx};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CompanyDomainAlias {
    pub slug: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub retired_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub alias_until: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TenantDomainRequestState {
    pub pending_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub requested_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_domain: Option<String>,
    pub account_count: i64,
    pub domain_aliases: Vec<CompanyDomainAlias>,
}

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

    pub async fn request_company_domain(
        &self,
        pool: &sqlx::PgPool,
        actor: UserId,
        org: OrgId,
        slug: &str,
        key: &str,
        now: OffsetDateTime,
    ) -> Result<(), ProvisioningError> {
        self.request_company_domain_checked(pool, actor, org, slug, None, key, now)
            .await
            .map(|_| ())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn request_company_domain_checked(
        &self,
        pool: &sqlx::PgPool,
        actor: UserId,
        org: OrgId,
        slug: &str,
        expected_pending: Option<Option<&str>>,
        key: &str,
        now: OffsetDateTime,
    ) -> Result<TenantDomainRequestState, ProvisioningError> {
        let mut tx = begin_domain_request(pool, actor, org).await?;
        use console_platform_db::idempotency::{
            IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
        };
        let input = serde_json::json!({
            "actor": actor,
            "slug": slug,
            "expected_pending": expected_pending,
        });
        match claim_idempotency_key(&mut tx, "tenant.domain.request", key, &input).await? {
            IdempotencyClaim::Replay(_) => {
                let state = load_state_in_tx(&mut tx, org).await?;
                tx.commit().await?;
                return Ok(state);
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
        if let Some(expected) = expected_pending {
            let existing: Option<String> = sqlx::query_scalar(
                "SELECT slug FROM organization_domain_requests WHERE org_id = $1 AND resolved_at IS NULL",
            )
            .bind(org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?;
            if existing.as_deref() != expected {
                return Err(ProvisioningError::DomainRequestConflict);
            }
        }
        if current.as_deref() == Some(slug)
            || console_platform_auth::normalize_company_domain(slug).as_deref() != Some(slug)
        {
            return Err(ProvisioningError::SlugInvalid(
                "invalid requested company domain".into(),
            ));
        }
        let existing_same: Option<String> = sqlx::query_scalar(
            "SELECT slug FROM organization_domain_requests WHERE org_id = $1 AND resolved_at IS NULL",
        )
        .bind(org.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?;
        if existing_same.as_deref() != Some(slug) {
            let available: bool =
                sqlx::query_scalar("SELECT platform_company_domain_available($1)")
                    .bind(slug)
                    .fetch_one(tx.as_mut())
                    .await?;
            if !available {
                return Err(ProvisioningError::SlugTaken);
            }
        }
        sqlx::query(
            "INSERT INTO organization_domain_requests (org_id,slug,requested_by,requested_at) VALUES ($1,$2,$3,$4) \
             ON CONFLICT(org_id) DO UPDATE SET slug=excluded.slug, requested_by=excluded.requested_by, requested_at=excluded.requested_at, resolved_at=NULL",
        )
        .bind(org.as_uuid())
        .bind(slug)
        .bind(actor.as_uuid())
        .bind(now)
        .execute(tx.as_mut())
        .await?;
        let audit = AuditEvent::new(
            Some(actor),
            AuditAction::new("tenant.domain.request")?,
            "organizations",
            org.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(org)
        .with_snapshots(None, Some(serde_json::json!({ "requested_domain": slug })));
        insert_audit_event(&mut tx, &audit).await?;
        let state = load_state_in_tx(&mut tx, org).await?;
        complete_idempotency_key(
            &mut tx,
            "tenant.domain.request",
            key,
            &serde_json::json!({ "pending_domain": slug }),
        )
        .await?;
        tx.commit().await?;
        Ok(state)
    }

    pub async fn own_company_domain_request(
        &self,
        pool: &sqlx::PgPool,
        actor: UserId,
        org: OrgId,
    ) -> Result<Option<String>, ProvisioningError> {
        Ok(self
            .read_company_domain_state(pool, actor, org)
            .await?
            .pending_domain)
    }

    pub async fn read_company_domain_state(
        &self,
        pool: &sqlx::PgPool,
        actor: UserId,
        org: OrgId,
    ) -> Result<TenantDomainRequestState, ProvisioningError> {
        let mut tx = begin_domain_request(pool, actor, org).await?;
        let state = load_state_in_tx(&mut tx, org).await?;
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
        Ok(state)
    }

    pub async fn cancel_company_domain_request(
        &self,
        pool: &sqlx::PgPool,
        actor: UserId,
        org: OrgId,
        now: OffsetDateTime,
    ) -> Result<TenantDomainRequestState, ProvisioningError> {
        let mut tx = begin_domain_request(pool, actor, org).await?;
        let prev: Option<String> = sqlx::query_scalar(
            "UPDATE organization_domain_requests
                SET resolved_at = $2
              WHERE org_id = $1 AND resolved_at IS NULL
          RETURNING slug",
        )
        .bind(org.as_uuid())
        .bind(now)
        .fetch_optional(tx.as_mut())
        .await?;
        let audit = AuditEvent::new(
            Some(actor),
            AuditAction::new("tenant.domain.request.cancel")?,
            "organizations",
            org.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(org)
        .with_snapshots(
            prev.map(|slug| serde_json::json!({ "pending_domain": slug })),
            Some(serde_json::json!({ "pending_domain": serde_json::Value::Null })),
        );
        insert_audit_event(&mut tx, &audit).await?;
        let state = load_state_in_tx(&mut tx, org).await?;
        tx.commit().await?;
        Ok(state)
    }
}
