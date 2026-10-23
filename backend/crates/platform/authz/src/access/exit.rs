//! A leaver's access ends with the exit (access-model §5.3, governance-04).
//! Called inside the exit confirmation's transaction, so the exit and the end
//! of access commit together or not at all. The credential and session sweep
//! is shared with account deactivation.

use console_kernel_core::{
    AuditAction, AuditEvent, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

fn db(err: sqlx::Error) -> KernelError {
    KernelError::internal(format!("access revocation failed: {err}"))
}

fn user_event(
    action: &str,
    actor: UserId,
    user: UserId,
    trace: &TraceContext,
    at: Timestamp,
    org: OrgId,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        "user",
        user.to_string(),
        trace.clone(),
        at,
    )
    .with_org(org))
}

/// One credential and session sweep: its two audit events and the counts.
pub struct CredentialSweep {
    pub credential_event: AuditEvent,
    pub session_event: AuditEvent,
    pub revoked_credentials: u64,
    pub revoked_families: u64,
}

/// Delete every passkey of `user` and revoke every refresh-token family and
/// token. Idempotent. `reason` is recorded on both events.
///
/// # Errors
/// A query failure; the caller rolls back.
pub async fn sweep_credentials_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    user: UserId,
    trace: &TraceContext,
    at: Timestamp,
    reason: &str,
) -> Result<CredentialSweep, KernelError> {
    let revoked_credentials =
        sqlx::query("DELETE FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(*user.as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(db)?
            .rows_affected();
    let revoked_families = sqlx::query(
        "UPDATE auth_refresh_token_families SET revoked_at = $2, revoked_reason = $3
          WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(*user.as_uuid())
    .bind(at)
    .bind(reason)
    .execute(tx.as_mut())
    .await
    .map_err(db)?
    .rows_affected();
    sqlx::query(
        "UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1",
    )
    .bind(*user.as_uuid())
    .bind(at)
    .execute(tx.as_mut())
    .await
    .map_err(db)?;
    let credential_event = user_event("auth.passkey.revoke_all", actor, user, trace, at, org)?
        .with_snapshots(
            None,
            Some(json!({ "reason": reason, "revoked_credential_count": revoked_credentials })),
        );
    let session_event = user_event("auth.refresh.revoke_all", actor, user, trace, at, org)?
        .with_snapshots(
            None,
            Some(json!({ "reason": reason, "revoked_family_count": revoked_families })),
        );
    Ok(CredentialSweep {
        credential_event,
        session_event,
        revoked_credentials,
        revoked_families,
    })
}

/// Any access token minted before now is stale to the next authorization.
async fn bump_session_generation(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    user: Uuid,
    at: Timestamp,
) -> Result<(), KernelError> {
    sqlx::query(
        "INSERT INTO subject_authz_versions (org_id, user_id, version, session_generation, updated_at)
         VALUES ($1, $2, 1, 1, $3)
         ON CONFLICT (org_id, user_id) DO UPDATE
         SET session_generation = subject_authz_versions.session_generation + 1,
             updated_at = EXCLUDED.updated_at",
    )
    .bind(org.as_uuid())
    .bind(user)
    .bind(at)
    .execute(tx.as_mut())
    .await
    .map_err(db)?;
    Ok(())
}

/// What an exit did to the leaver's account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitRevocation {
    /// The account linked to the employee, if any.
    pub account: Option<Uuid>,
    /// Grants whose end moved to `ends_at` (or that were revoked, not yet begun).
    pub grants_ended: u64,
    /// The account is suspended now (its end has passed).
    pub suspended: bool,
}

/// End the access of the account linked to `employee` at `ends_at`: every
/// active or pending grant ends by then (one that would only start later is revoked), and
/// when `ends_at` is not in the future the account is suspended with its
/// passkeys and sessions. The tenant's ops account is never suspended (lockout
/// invariant): its sessions end and a vendor handover is needed.
///
/// # Errors
/// A query failure; the caller rolls the exit back.
pub async fn revoke_privileged_access(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    employee: Uuid,
    ends_at: Timestamp,
    actor: UserId,
    now: Timestamp,
) -> Result<(ExitRevocation, Vec<AuditEvent>), KernelError> {
    let account: Option<(Uuid, bool, bool)> = sqlx::query_as(
        "SELECT id, is_tenant_ops, is_active FROM users
          WHERE org_id = $1 AND employee_id = $2 FOR NO KEY UPDATE",
    )
    .bind(org.as_uuid())
    .bind(employee)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(db)?;
    let Some((account, is_ops, is_active)) = account else {
        let none = ExitRevocation {
            account: None,
            grants_ended: 0,
            suspended: false,
        };
        return Ok((none, Vec::new()));
    };
    let user = UserId::from_uuid(account);
    let not_begun = sqlx::query(
        "UPDATE access_grants SET status = 'REVOKED', revoked_by = $3, revoked_at = $5
          WHERE org_id = $1 AND account_id = $2 AND status IN ('ACTIVE', 'PENDING') AND valid_from >= $4",
    )
    .bind(org.as_uuid())
    .bind(account)
    .bind(actor.as_uuid())
    .bind(ends_at)
    .bind(now)
    .execute(tx.as_mut())
    .await
    .map_err(db)?
    .rows_affected();
    let shortened = sqlx::query(
        "UPDATE access_grants SET valid_to = $3
          WHERE org_id = $1 AND account_id = $2 AND status IN ('ACTIVE', 'PENDING')
            AND (valid_to IS NULL OR valid_to > $3)",
    )
    .bind(org.as_uuid())
    .bind(account)
    .bind(ends_at)
    .execute(tx.as_mut())
    .await
    .map_err(db)?
    .rows_affected();

    let trace = TraceContext::generate();
    let mut events = Vec::new();
    let due = ends_at <= now;
    let suspended = due && is_active && !is_ops;
    if due {
        if !is_ops && is_active {
            sqlx::query("UPDATE users SET is_active = false WHERE org_id = $1 AND id = $2")
                .bind(org.as_uuid())
                .bind(account)
                .execute(tx.as_mut())
                .await
                .map_err(db)?;
        }
        // The ops holder keeps the account (lockout invariant) and its
        // passkeys; its sessions end until the vendor handover.
        if is_ops {
            sqlx::query(
                "UPDATE auth_refresh_token_families SET revoked_at = $2, revoked_reason = 'ops_holder_exit'
                  WHERE user_id = $1 AND revoked_at IS NULL",
            )
            .bind(account)
            .bind(now)
            .execute(tx.as_mut())
            .await
            .map_err(db)?;
        } else {
            let sweep =
                sweep_credentials_tx(tx, org, actor, user, &trace, now, "employee_exit").await?;
            events.push(sweep.credential_event);
            events.push(sweep.session_event);
        }
        bump_session_generation(tx, org, account, now).await?;
    }
    let grants_ended = not_begun + shortened;
    events.push(
        user_event("user.access.end_on_exit", actor, user, &trace, now, org)?.with_snapshots(
            Some(json!({ "is_active": is_active })),
            Some(json!({
                "employee_id": employee,
                "ends_at": ends_at,
                "grants_ended": grants_ended,
                "suspended": suspended,
                "ops_handover_required": is_ops,
            })),
        ),
    );
    let done = ExitRevocation {
        account: Some(account),
        grants_ended,
        suspended,
    };
    Ok((done, events))
}
