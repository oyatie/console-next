// SPDX-License-Identifier: LicenseRef-Proprietary
//! In-transaction ops account holder designation and self-only release on the
//! canonical `users` + `ops_account_holders` tables (`1..=2` active holders).

use crate::PgOrgError;
use console_identity_application::user_audit_event;
use console_kernel_core::{AuditEvent, KernelError, OrgId, TraceContext, UserId};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

fn coded(err: KernelError, code: &'static str) -> PgOrgError {
    PgOrgError::Domain(err.with_code(code))
}

/// Designate `target` as a second active ops account holder (`<= 2` per tenant).
/// Only an existing active ops account holder (`actor`) may designate another.
pub async fn designate_ops_holder_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: Uuid,
    target: Uuid,
    now: OffsetDateTime,
) -> Result<AuditEvent, PgOrgError> {
    let org_uuid = *org.as_uuid();
    let active_holders: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE org_id = $1 AND is_tenant_ops AND is_active ORDER BY id FOR UPDATE",
    )
    .bind(org_uuid)
    .fetch_all(tx.as_mut())
    .await?;

    if !active_holders.contains(&actor) {
        return Err(coded(
            KernelError::forbidden(
                "only an active ops account holder can designate another holder",
            ),
            "ops_holder_only",
        ));
    }

    let target_row = sqlx::query(
        "SELECT is_active, is_tenant_ops FROM users WHERE org_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(org_uuid)
    .bind(target)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| {
        coded(
            KernelError::not_found("account not found"),
            "account_not_found",
        )
    })?;

    let target_active: bool = target_row.try_get("is_active")?;
    let target_is_ops: bool = target_row.try_get("is_tenant_ops")?;
    if !target_active {
        return Err(coded(
            KernelError::conflict("an inactive account cannot be designated as ops holder"),
            "account_inactive",
        ));
    }
    if target_is_ops {
        return Err(coded(
            KernelError::conflict("account is already an ops account holder"),
            "already_ops_holder",
        ));
    }
    if active_holders.len() >= 2 {
        return Err(coded(
            KernelError::conflict("at most 2 ops account holders are allowed per tenant"),
            "ops_holder_limit_reached",
        ));
    }

    let has_passkey: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM auth_webauthn_credentials WHERE org_id = $1 AND user_id = $2)",
    )
    .bind(org_uuid)
    .bind(target)
    .fetch_one(tx.as_mut())
    .await?;
    if !has_passkey {
        return Err(coded(
            KernelError::conflict("candidate must enroll a passkey before ops holder designation"),
            "ops_candidate_needs_passkey",
        ));
    }

    let has_grants: bool = sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT 1 FROM access_grants
             WHERE org_id = $1 AND account_id = $2 AND status <> 'REVOKED'
               AND (valid_to IS NULL OR valid_to > $3)
        )",
    )
    .bind(org_uuid)
    .bind(target)
    .bind(now)
    .fetch_one(tx.as_mut())
    .await?;
    if has_grants {
        return Err(coded(
            KernelError::conflict("revoke active role grants before designating an ops holder"),
            "ops_candidate_has_grants",
        ));
    }

    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE org_id = $1 AND id = $2")
        .bind(org_uuid)
        .bind(target)
        .execute(tx.as_mut())
        .await?;

    sqlx::query(
        "INSERT INTO ops_account_holders (org_id, user_id, designated_by, designated_at)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(org_uuid)
    .bind(target)
    .bind(actor)
    .bind(now)
    .execute(tx.as_mut())
    .await?;

    let event = user_audit_event(
        "ops_holder.designate",
        Some(UserId::from_uuid(actor)),
        UserId::from_uuid(target),
        TraceContext::generate(),
        now,
    )?
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "designated_user_id": target,
            "holder_count": active_holders.len() + 1,
        })),
    );
    Ok(event)
}

/// Self-only release of ops account holder status (`>= 1` active holder must remain).
pub async fn release_self_ops_holder_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: Uuid,
    requested_target: Option<Uuid>,
    reason: Option<&str>,
    now: OffsetDateTime,
) -> Result<AuditEvent, PgOrgError> {
    if requested_target.is_some_and(|target| target != actor) {
        return Err(coded(
            KernelError::forbidden(
                "an ops account holder can release only their own holder status",
            ),
            "ops_release_self_only",
        ));
    }

    let org_uuid = *org.as_uuid();
    let active_holders: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE org_id = $1 AND is_tenant_ops AND is_active ORDER BY id FOR UPDATE",
    )
    .bind(org_uuid)
    .fetch_all(tx.as_mut())
    .await?;

    if !active_holders.contains(&actor) {
        return Err(coded(
            KernelError::forbidden("only an active ops account holder can release holder status"),
            "ops_holder_only",
        ));
    }
    if active_holders.len() <= 1 {
        return Err(coded(
            KernelError::conflict("at least one active ops account holder must remain"),
            "last_ops_holder",
        ));
    }

    let release_reason = reason
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("SELF_RELEASE");
    if release_reason.chars().count() > 200 {
        return Err(coded(
            KernelError::validation("release reason must be 1..200 characters"),
            "release_reason_invalid",
        ));
    }

    sqlx::query("UPDATE users SET is_tenant_ops = false WHERE org_id = $1 AND id = $2")
        .bind(org_uuid)
        .bind(actor)
        .execute(tx.as_mut())
        .await?;

    sqlx::query(
        "UPDATE ops_account_holders
            SET released_at = $3, release_reason = $4
          WHERE org_id = $1 AND user_id = $2 AND released_at IS NULL",
    )
    .bind(org_uuid)
    .bind(actor)
    .bind(now)
    .bind(release_reason)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(
        "UPDATE recovery_codes
            SET revoked_at = $3, revoked_reason = 'holder_released'
          WHERE org_id = $1 AND user_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL",
    )
    .bind(org_uuid)
    .bind(actor)
    .bind(now)
    .execute(tx.as_mut())
    .await?;

    let event = user_audit_event(
        "ops_holder.release",
        Some(UserId::from_uuid(actor)),
        UserId::from_uuid(actor),
        TraceContext::generate(),
        now,
    )?
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "released_user_id": actor,
            "holder_count": active_holders.len() - 1,
            "release_reason": release_reason,
        })),
    );
    Ok(event)
}
