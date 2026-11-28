// SPDX-License-Identifier: LicenseRef-Proprietary
//! Out-of-band contact challenge issuance and active recovery-request
//! auto-cancellation when an ops holder signs in on an active tenant.

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::{insert_audit_event, with_audits};
use console_platform_email::EmailSender;
use secrecy::ExposeSecret;
use sqlx::{PgPool, Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::ops_self_recovery::{
    RecoveryChannel, RecoveryContactCipher, decrypt_recovery_contact_tx, hash_recovery_challenge,
    load_recovery_codes_summary_tx,
};
use crate::{BootstrapCredentialStore, ProvisioningError, generate_bootstrap_token};

const CHALLENGE_TTL_MINUTES: i64 = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryChallengeIssue {
    pub sent: bool,
    pub expires_at: OffsetDateTime,
    /// Populated only for `#[cfg(any(test, debug_assertions))]` test harnesses;
    /// never serialized over HTTP.
    pub debug_contact_code: Option<String>,
}

/// Cancel any open `ops_recovery_requests` row when an active ops holder signs in
/// on an `ACTIVE` tenant. Suspended tenants never cancel on sign-in.
pub async fn cancel_open_ops_recovery_on_holder_login_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    user_id: Uuid,
    now: OffsetDateTime,
) -> Result<bool, ProvisioningError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM organizations WHERE id = $1")
            .bind(org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?;
    if status.as_deref() != Some("ACTIVE") {
        return Ok(false);
    }
    let is_ops: Option<bool> = sqlx::query_scalar(
        "SELECT is_tenant_ops AND is_active FROM users WHERE org_id = $1 AND id = $2",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    if is_ops != Some(true) {
        return Ok(false);
    }
    let cancelled: Option<Uuid> = sqlx::query_scalar(
        "UPDATE ops_recovery_requests
            SET cancelled_by = $2, cancelled_at = $3, cancel_reason = 'holder_signed_in'
          WHERE org_id = $1 AND cancelled_at IS NULL AND issued_at IS NULL
      RETURNING id",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .bind(now)
    .fetch_optional(tx.as_mut())
    .await?;
    if let Some(request_id) = cancelled {
        let audit = AuditEvent::new(
            Some(UserId::from_uuid(user_id)),
            AuditAction::new("ops_recovery.auto_cancel_on_signin")?,
            "ops_recovery_request",
            request_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({ "cancel_reason": "holder_signed_in" })),
        );
        insert_audit_event(tx, &audit).await?;
        return Ok(true);
    }
    Ok(false)
}

/// Issue a short-lived verification code to the ops holder's stored recovery
/// contact without revealing whether `identifier` belongs to an ops holder.
pub async fn issue_recovery_challenge(
    pool: &PgPool,
    store: &BootstrapCredentialStore,
    cipher: &RecoveryContactCipher,
    email_sender: &dyn EmailSender,
    identifier: &str,
    now: OffsetDateTime,
) -> Result<RecoveryChallengeIssue, ProvisioningError> {
    let expires_at = now + Duration::minutes(CHALLENGE_TTL_MINUTES);
    let trimmed = identifier.trim();
    let Some((login, slug)) = trimmed.split_once('@') else {
        return Ok(RecoveryChallengeIssue {
            sent: true,
            expires_at,
            debug_contact_code: None,
        });
    };
    if login.is_empty() || slug.is_empty() || !email_sender.can_send() {
        return Ok(RecoveryChallengeIssue {
            sent: true,
            expires_at,
            debug_contact_code: None,
        });
    }
    let resolved: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT org_id, user_id FROM platform_resolve_recovery_identifier($1, $2)")
            .bind(login)
            .bind(slug)
            // rls-arming: ok narrow SECURITY DEFINER resolver maps login@slug to (org_id, user_id) before arming app.current_org
            .fetch_optional(pool)
            .await?;
    let Some((org_uuid, user_id)) = resolved else {
        return Ok(RecoveryChallengeIssue {
            sent: true,
            expires_at,
            debug_contact_code: None,
        });
    };
    let org = OrgId::from_uuid(org_uuid);
    let hmac_key = store.resolve_hmac_key()?;
    let cipher_clone = cipher.clone();
    let prepared = with_audits::<_, Option<(RecoveryChannel, secrecy::SecretString, String)>, ProvisioningError>(
        pool,
        org,
        move |tx| {
            Box::pin(async move {
                let active_holder: Option<bool> = sqlx::query_scalar(
                    "SELECT is_tenant_ops AND is_active FROM users WHERE org_id = $1 AND id = $2 FOR SHARE",
                )
                .bind(org.as_uuid())
                .bind(user_id)
                .fetch_optional(tx.as_mut()).await?;
                if active_holder != Some(true) {
                    return Ok((None, Vec::new()));
                }
                let summary = load_recovery_codes_summary_tx(tx, org, user_id).await?;
                if summary.remaining <= 0 {
                    return Ok((None, Vec::new()));
                }
                let Some((channel, secret_dest, _masked)) =
                    decrypt_recovery_contact_tx(tx, &cipher_clone, org, user_id).await?
                else {
                    return Ok((None, Vec::new()));
                };
                if channel != RecoveryChannel::Email {
                    return Ok((None, Vec::new()));
                }
                let token = generate_bootstrap_token()?;
                let code_str = token.as_str().to_owned();
                let Some(challenge_hash) = hash_recovery_challenge(&hmac_key, &code_str) else {
                    return Ok((None, Vec::new()));
                };
                let challenge_id = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO recovery_contact_challenges (org_id, id, user_id, challenge_hash, issued_at, expires_at)
                     VALUES ($1, $2, $3, $4, $5, $6)",
                )
                .bind(org.as_uuid())
                .bind(challenge_id)
                .bind(user_id)
                .bind(&challenge_hash)
                .bind(now)
                .bind(expires_at)
                .execute(tx.as_mut())
                .await?;
                let event = AuditEvent::new(
                    Some(UserId::from_uuid(user_id)),
                    AuditAction::new("auth.recovery_challenge.issue")?,
                    "recovery_contact_challenge",
                    challenge_id.to_string(),
                    TraceContext::generate(),
                    now,
                )
                .with_org(org);
                Ok((Some((channel, secret_dest, code_str)), vec![event]))
            })
        },
    )
    .await?;

    let debug_code = if let Some((_channel, dest, code)) = prepared {
        match email_sender
            .send_otp(
                dest.expose_secret(),
                &code,
                std::time::Duration::from_secs(600),
            )
            .await
        {
            Ok(()) if cfg!(debug_assertions) => Some(code),
            Ok(()) => None,
            Err(_) => {
                tracing::warn!("recovery challenge transport failed");
                None
            }
        }
    } else {
        None
    };
    Ok(RecoveryChallengeIssue {
        sent: true,
        expires_at,
        debug_contact_code: debug_code,
    })
}
