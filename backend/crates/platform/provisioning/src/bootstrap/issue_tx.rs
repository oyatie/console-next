use crate::{BootstrapCredentialIssue, ProvisioningError, generate_bootstrap_token, hash_token};
use console_kernel_core::OrgId;
use console_platform_auth::{authentication_time_tx, lock_account_tx};
use sqlx::{Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// Controls how [`issue_bootstrap_if_needed_tx`] reacts to a user who already has
/// a registered passkey or an open bootstrap credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IssueMode {
    /// Roster cold-start: a user who already has a passkey or an open credential is
    /// silently skipped (`Ok(None)`). Used for idempotent bulk import.
    SkipIfPresent,
    /// Admin-issued OTP for a zero-credential user: a user who already has a passkey
    /// or an open credential is an ERROR (the caller surfaces a 409). This is the
    /// safe default that keeps an admin from clobbering a user who can already log in.
    RejectIfPresent,
    /// Admin credential RESET (account-recovery escape hatch): the caller has ALREADY
    /// revoked the user's passkeys in this same transaction, so the passkey-existence
    /// check is bypassed and any leftover open bootstrap credential is revoked before
    /// a fresh one is minted. Always issues a new OTP.
    ForceReset,
    /// Platform reissue of a tenant admin's cold-start code: a user with a
    /// passkey is an ERROR (as `RejectIfPresent`), but an open code is revoked
    /// (`reissued`) and replaced instead of refusing.
    Reissue,
}

pub(crate) async fn require_active_account_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    user: Uuid,
) -> Result<(), ProvisioningError> {
    if lock_account_tx(tx, org, user).await? != Some(true) {
        return Err(ProvisioningError::InvalidBootstrapCredential);
    }
    Ok(())
}

pub(crate) async fn lock_open_bootstrap_tx(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT id FROM auth_bootstrap_credentials WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL ORDER BY id FOR UPDATE")
        .bind(user).fetch_all(tx.as_mut()).await?;
    Ok(())
}

pub(crate) async fn issue_bootstrap_if_needed_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    org: OrgId,
    now: OffsetDateTime,
    ttl: Duration,
    mode: IssueMode,
) -> Result<Option<BootstrapCredentialIssue>, ProvisioningError> {
    require_active_account_tx(tx, org, user_id).await?;
    lock_open_bootstrap_tx(tx, user_id).await?;
    let now = authentication_time_tx(tx, now).await?;
    let expired: Vec<Uuid> = sqlx::query_scalar(
        r#"
        UPDATE auth_bootstrap_credentials
        SET revoked_at = $1, revoked_reason = 'expired'
        WHERE user_id = $2
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at <= $1
        RETURNING id
        "#,
    )
    .bind(now)
    .bind(user_id)
    .fetch_all(tx.as_mut())
    .await?;
    revoke_legacy_otp_families_for_sources_tx(tx, org, user_id, &expired, now).await?;

    // ForceReset is the account-recovery escape hatch: the caller has just revoked
    // every passkey for this user in the SAME transaction, so a non-zero count here
    // would be a stale read of rows already deleted — skip the lockout-preserving
    // passkey check entirely. SkipIfPresent / RejectIfPresent keep enforcing it.
    if mode != IssueMode::ForceReset {
        let passkey_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
                .bind(user_id)
                .fetch_one(tx.as_mut())
                .await?;
        if passkey_count > 0 {
            if matches!(mode, IssueMode::RejectIfPresent | IssueMode::Reissue) {
                return Err(ProvisioningError::UserAlreadyHasPasskey);
            }
            return Ok(None);
        }
    }

    let existing_active: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM auth_bootstrap_credentials
        WHERE user_id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    if existing_active.is_some() {
        match mode {
            // Reset always supersedes any stale open code: revoke it so the freshly
            // minted OTP is the user's single valid recovery code.
            IssueMode::ForceReset | IssueMode::Reissue => {
                let replaced: Vec<Uuid> = sqlx::query_scalar(
                    r#"
                    UPDATE auth_bootstrap_credentials
                    SET revoked_at = $1, revoked_reason = $3
                    WHERE user_id = $2
                      AND consumed_at IS NULL
                      AND revoked_at IS NULL
                    RETURNING id
                    "#,
                )
                .bind(now)
                .bind(user_id)
                .bind(if mode == IssueMode::Reissue {
                    "reissued"
                } else {
                    "reset"
                })
                .fetch_all(tx.as_mut())
                .await?;
                revoke_legacy_otp_families_for_sources_tx(tx, org, user_id, &replaced, now).await?;
            }
            IssueMode::RejectIfPresent => {
                return Err(ProvisioningError::ActiveBootstrapCredentialExists);
            }
            IssueMode::SkipIfPresent => {
                return Ok(None);
            }
        }
    }

    let credential_id = Uuid::new_v4();
    let token = generate_bootstrap_token();
    let token_hash = hash_token(token.as_str());
    let expires_at = now + ttl;

    // Stamp the credential with the caller-supplied tenant `org`. The caller
    // must arm the SAME org as `app.current_org` for the transaction so the row
    // passes the FORCE-RLS WITH CHECK on `auth_bootstrap_credentials` (tenant #1 roster
    // import, a newly-onboarded org, or an admin-issued OTP).
    sqlx::query(
        r#"
        INSERT INTO auth_bootstrap_credentials (
            id, user_id, token_hash, issued_at, expires_at, org_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(credential_id)
    .bind(user_id)
    .bind(token_hash)
    .bind(now)
    .bind(expires_at)
    .bind(*org.as_uuid())
    .execute(tx.as_mut())
    .await?;

    Ok(Some(BootstrapCredentialIssue {
        credential_id,
        user_id,
        token,
        expires_at,
    }))
}

pub(crate) async fn revoke_legacy_otp_families_for_sources_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    user_id: Uuid,
    sources: &[Uuid],
    now: OffsetDateTime,
) -> Result<(), ProvisioningError> {
    if sources.is_empty() {
        return Ok(());
    }
    let families: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE auth_refresh_token_families f \
         SET revoked_at=$1, revoked_reason='bootstrap_source_revoked' \
         FROM auth_legacy_otp_family_sources s \
         WHERE f.id=s.family_id AND s.source_id=ANY($2) \
           AND f.user_id=$3 AND f.org_id=$4 AND s.user_id=$3 AND s.org_id=$4 \
           AND f.revoked_at IS NULL RETURNING f.id",
    )
    .bind(now)
    .bind(sources)
    .bind(user_id)
    .bind(*org.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    if !families.is_empty() {
        sqlx::query(
            "UPDATE auth_refresh_tokens SET revoked_at=COALESCE(revoked_at,$1) \
             WHERE family_id=ANY($2) AND user_id=$3 AND org_id=$4",
        )
        .bind(now)
        .bind(&families)
        .bind(user_id)
        .bind(*org.as_uuid())
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}
