use crate::{PlatformProvisioner, ProvisioningError, TenantRemovalOutcome, fetch_org_tx};
use console_kernel_core::{AuditAction, AuditEvent, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

impl PlatformProvisioner {
    /// GUARDED hard-removal of a tenant: delete the org AND its empty onboarding
    /// shell, in ONE transaction, AUDITED — but ONLY for an empty/test tenant.
    ///
    /// Runs the SECURITY DEFINER `platform_remove_organization` (migration 0051),
    /// which REFUSES (returns `blocked_has_data`) if the tenant owns any real
    /// operational data (registry equipment / work orders / sites / customers /
    /// inspections / sales / financial / messenger / consents / attendance /
    /// findings), and otherwise deletes the shell children-first and the org row,
    /// re-homing the tenant's immutable `audit_events` to the platform sentinel so
    /// the audit trail survives the tenant. A non-empty tenant is NEVER hard-
    /// deleted — the caller surfaces a 409 telling the operator to archive instead.
    ///
    /// The removal + the `platform.tenant.remove` audit row commit atomically: the
    /// audit row carries `org_id = NULL` (PLATFORM-tier), because the target org no
    /// longer exists and so could not satisfy the `audit_events` org FK / WITH
    /// CHECK — exactly like the `platform.tenant.list`/`health` reads.
    pub async fn remove_tenant(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        org_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<TenantRemovalOutcome, ProvisioningError> {
        let mut tx = pool.begin().await?;

        // Capture the slug for the audit snapshot BEFORE the org row is deleted by
        // the function below (so the trail records WHAT was removed, by name).
        let slug: Option<String> = fetch_org_tx(&mut tx, org_id).await.map(|org| org.slug).ok();

        let outcome_code: String = sqlx::query_scalar("SELECT platform_remove_organization($1)")
            .bind(org_id)
            .fetch_one(tx.as_mut())
            .await?;

        let outcome = match outcome_code.as_str() {
            "removed" => TenantRemovalOutcome::Removed,
            "blocked_legal_hold" => {
                tx.rollback().await?;
                return Ok(TenantRemovalOutcome::BlockedLegalHold);
            }
            "blocked_has_data" => {
                // Nothing was changed by the function; roll back and refuse so the
                // REST layer returns 409 "archive instead".
                tx.rollback().await?;
                return Ok(TenantRemovalOutcome::BlockedHasData);
            }
            "not_found" => {
                tx.rollback().await?;
                return Ok(TenantRemovalOutcome::NotFound);
            }
            other => {
                tx.rollback().await?;
                return Err(ProvisioningError::InvalidRoster(format!(
                    "unexpected tenant-removal outcome {other:?}"
                )));
            }
        };

        // Audit the removal as a PLATFORM-tier event (org_id = NULL): the target
        // org is gone, so a tenant-scoped audit row would fail the org FK. The GUC
        // is deliberately left unarmed — the `audit_events` WITH CHECK allows a
        // NULL-org platform row with no tenant armed.
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.remove")?,
            "organizations",
            org_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "org_id": org_id,
                "slug": slug,
            })),
        );
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(outcome)
    }

    /// Execute an approved, cooled erasure through the isolated command role.
    /// The database rechecks both operators, their bound proofs, archive status
    /// and legal holds before erasing data and preserving the immutable receipt.
    pub async fn force_remove_tenant(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        org_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<TenantRemovalOutcome, ProvisioningError> {
        let actor = actor.ok_or_else(|| {
            ProvisioningError::InvalidRoster(
                "platform force removal requires an authenticated actor".to_owned(),
            )
        })?;
        let trace = TraceContext::generate();
        let outcome_code: String = sqlx::query_scalar(
            "SELECT platform_force_remove_organization_command($1, $2, $3, $4, $5)",
        )
        .bind(org_id)
        .bind(*actor.as_uuid())
        .bind(trace.trace_id())
        .bind(trace.span_id())
        .bind(now)
        // rls-arming: ok isolated SECURITY DEFINER control-plane command; the pool has no tenant-table grants.
        .fetch_one(pool)
        .await?;

        match outcome_code.as_str() {
            "removed" => Ok(TenantRemovalOutcome::Removed),
            "blocked_legal_hold" => Ok(TenantRemovalOutcome::BlockedLegalHold),
            "blocked_active" => Ok(TenantRemovalOutcome::BlockedActive),
            "not_found" => Ok(TenantRemovalOutcome::NotFound),
            "erase_requires_second_operator" => Err(ProvisioningError::TenantErase(
                "erase_requires_second_operator",
            )),
            "erase_same_operator" => Err(ProvisioningError::TenantErase("erase_same_operator")),
            "erase_cooling" => Err(ProvisioningError::TenantErase("erase_cooling")),
            other => Err(ProvisioningError::InvalidRoster(format!(
                "unexpected tenant force-removal outcome {other:?}"
            ))),
        }
    }
}
