// SPDX-License-Identifier: LicenseRef-Proprietary
//! Atomic single-use recovery code + contact challenge redemption.

use aws_lc_rs::constant_time::verify_slices_are_equal;
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_auth::{authentication_time_tx, lock_account_tx};
use console_platform_db::insert_audit_event;
use sqlx::{Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::ops_self_recovery::{
    cancel_open_ops_recovery_on_holder_login_tx, hash_recovery_challenge, hash_recovery_code,
};
use crate::{BootstrapCredentialStore, IssueMode, ProvisioningError, issue_bootstrap_if_needed_tx};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryCodeRedemption {
    pub user_id: Uuid,
    pub org_id: OrgId,
    pub source_credential_id: Uuid,
    pub expires_at: OffsetDateTime,
    pub cancelled_recovery_request: bool,
}

/// Atomically redeem one saved recovery code + one contact challenge code in a
/// single caller-owned transaction. Any failure returns an error so the caller
/// rolls back the transaction with zero partial state.
pub async fn redeem_recovery_code_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    store: &BootstrapCredentialStore,
    recovery_code: &str,
    contact_code: &str,
    now: OffsetDateTime,
    enrollment_ttl: Duration,
) -> Result<RecoveryCodeRedemption, ProvisioningError> {
    let hmac_key = store.resolve_hmac_key()?;
    let code_hash = hash_recovery_code(&hmac_key, recovery_code)
        .ok_or(ProvisioningError::InvalidBootstrapCredential)?;
    let challenge_hash = hash_recovery_challenge(&hmac_key, contact_code)
        .ok_or(ProvisioningError::InvalidBootstrapCredential)?;

    let org_uuid: Option<Uuid> =
        sqlx::query_scalar("SELECT platform_resolve_recovery_code_org($1)")
            .bind(&code_hash)
            .fetch_one(tx.as_mut())
            .await?;
    let Some(org_uuid) = org_uuid else {
        return Err(ProvisioningError::InvalidBootstrapCredential);
    };

    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org_uuid.to_string())
        .execute(tx.as_mut())
        .await?;

    let locator: Option<(Uuid, Uuid, Vec<u8>)> = sqlx::query_as(
        "SELECT id, user_id, code_hash
           FROM recovery_codes
          WHERE org_id = $1 AND code_hash = $2 AND consumed_at IS NULL AND revoked_at IS NULL",
    )
    .bind(org_uuid)
    .bind(&code_hash)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some((code_id, user_id, stored_hash)) = locator else {
        return Err(ProvisioningError::InvalidBootstrapCredential);
    };
    if verify_slices_are_equal(&stored_hash, &code_hash).is_err() {
        return Err(ProvisioningError::InvalidBootstrapCredential);
    }

    let org = OrgId::from_uuid(org_uuid);
    if lock_account_tx(tx, org, user_id).await? != Some(true) {
        return Err(ProvisioningError::InvalidBootstrapCredential);
    }
    let is_ops: Option<bool> =
        sqlx::query_scalar("SELECT is_tenant_ops FROM users WHERE org_id = $1 AND id = $2")
            .bind(org_uuid)
            .bind(user_id)
            .fetch_optional(tx.as_mut())
            .await?;
    if is_ops != Some(true) {
        return Err(ProvisioningError::InvalidBootstrapCredential);
    }

    let now = authentication_time_tx(tx, now).await?;

    let challenge_claimed = sqlx::query(
        "UPDATE recovery_contact_challenges
            SET consumed_at = $4
          WHERE org_id = $1
            AND user_id = $2
            AND challenge_hash = $3
            AND consumed_at IS NULL
            AND expires_at > $4",
    )
    .bind(org_uuid)
    .bind(user_id)
    .bind(&challenge_hash)
    .bind(now)
    .execute(tx.as_mut())
    .await?;
    if challenge_claimed.rows_affected() != 1 {
        return Err(ProvisioningError::InvalidBootstrapCredential);
    }

    let code_claimed = sqlx::query(
        "UPDATE recovery_codes
            SET consumed_at = $5
          WHERE org_id = $1
            AND id = $2
            AND user_id = $3
            AND code_hash = $4
            AND consumed_at IS NULL
            AND revoked_at IS NULL",
    )
    .bind(org_uuid)
    .bind(code_id)
    .bind(user_id)
    .bind(&code_hash)
    .bind(now)
    .execute(tx.as_mut())
    .await?;
    if code_claimed.rows_affected() != 1 {
        return Err(ProvisioningError::InvalidBootstrapCredential);
    }

    let org_status: Option<String> =
        sqlx::query_scalar("SELECT status FROM organizations WHERE id = $1")
            .bind(org_uuid)
            .fetch_optional(tx.as_mut())
            .await?;
    if org_status.as_deref() != Some("ACTIVE") {
        return Err(ProvisioningError::Forbidden("tenant_inactive".to_owned()));
    }

    sqlx::query("DELETE FROM auth_webauthn_credentials WHERE user_id = $1")
        .bind(user_id)
        .execute(tx.as_mut())
        .await?;
    sqlx::query(
        "UPDATE auth_refresh_token_families
            SET revoked_at = $3, revoked_reason = 'recovery_code_redeem'
          WHERE user_id = $1 AND org_id = $2 AND revoked_at IS NULL",
    )
    .bind(user_id)
    .bind(org_uuid)
    .bind(now)
    .execute(tx.as_mut())
    .await?;
    sqlx::query(
        "UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, $3)
          WHERE user_id = $1 AND org_id = $2",
    )
    .bind(user_id)
    .bind(org_uuid)
    .bind(now)
    .execute(tx.as_mut())
    .await?;

    let issue = issue_bootstrap_if_needed_tx(
        tx,
        &hmac_key,
        user_id,
        org,
        now,
        enrollment_ttl,
        IssueMode::ForceReset,
    )
    .await?
    .ok_or(ProvisioningError::InvalidBootstrapCredential)?;
    sqlx::query("UPDATE auth_bootstrap_credentials SET redeemed_at = $2 WHERE id = $1")
        .bind(issue.credential_id)
        .bind(now)
        .execute(tx.as_mut())
        .await?;

    let cancelled_recovery_request =
        cancel_open_ops_recovery_on_holder_login_tx(tx, org, user_id, now).await?;

    let audit = AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new("auth.recovery_code.redeem")?,
        "recovery_code",
        code_id.to_string(),
        TraceContext::generate(),
        now,
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "user_id": user_id,
            "cancelled_recovery_request": cancelled_recovery_request,
        })),
    );
    insert_audit_event(tx, &audit).await?;

    Ok(RecoveryCodeRedemption {
        user_id,
        org_id: org,
        source_credential_id: issue.credential_id,
        expires_at: issue.expires_at,
        cancelled_recovery_request,
    })
}
