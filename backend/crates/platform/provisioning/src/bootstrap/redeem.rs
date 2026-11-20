use crate::{
    BootstrapCredentialStore, OtpRedemption, OtpSource, PLATFORM_INVITE_TOKEN_PREFIX,
    ProvisioningError, count_user_passkeys_tx, hash_platform_invite_token, otp_lookup_candidates,
    require_active_account_tx, resolve_otp_candidate_org,
};
use aws_lc_rs::constant_time::verify_slices_are_equal;
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_auth::authentication_time_tx;
use console_platform_db::insert_audit_event;
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

impl BootstrapCredentialStore {
    /// Redeem a one-time OTP (bootstrap token) as a FIRST SIGN-IN.
    ///
    /// This is a sign-in, not signup: the user row was pre-provisioned by the
    /// admin who issued the OTP (or seeded for the cold-start admin). The
    /// redeeming user's id is returned so the caller can mint a session. Passkey
    /// enrollment is NOT bundled here — the user adds a passkey afterwards from
    /// authenticated initial settings.
    ///
    /// Security properties:
    /// * Every code atomically claims `redeemed_at` before session issue.
    ///   Legacy `consumed_at` stays open for that session's passkey enrollment.
    ///   Passkey registration later closes that source through
    ///   [`Self::consume_open_credentials_tx`].
    /// * A WRONG guess never consumes or invalidates a credential — an unknown
    ///   token simply finds no row. There is deliberately no per-OTP attempt cap
    ///   (that would let an attacker burn a victim's OTP); brute-force is bounded
    ///   by the caller's per-client rate limit plus the short TTL.
    /// * Expiry and revocation are still enforced here, so an expired or revoked
    ///   OTP cannot mint a session.
    ///
    /// All failure modes collapse to [`ProvisioningError::InvalidBootstrapCredential`]
    /// so the caller can return a single generic "invalid or expired" message
    /// without revealing whether the token was unknown, expired, or already used.
    pub async fn redeem_otp(
        &self,
        pool: &PgPool,
        token: &str,
        now: OffsetDateTime,
    ) -> Result<OtpRedemption, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let redemption = self.redeem_otp_in_tx(&mut tx, token, now).await?;
        // The compatibility wrapper has no family/admission owner. A version-1
        // source may be consumed only by its caller's complete transaction.
        if redemption.source.issuance_version != 0 {
            tx.rollback().await?;
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }
        tx.commit().await?;
        Ok(redemption)
    }

    /// Verify and audit an OTP while its exact source row remains locked in the
    /// caller's transaction. A session owner can add its family, token and audit
    /// before committing; a failed later step rolls this verification back too.
    /// Version 0 claims its login proof once. Version 1 requires the private
    /// never-enrolled generation and consumes its source once in this same
    /// transaction; the caller must also own family/admission completion.
    pub async fn redeem_otp_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        token: &str,
        now: OffsetDateTime,
    ) -> Result<OtpRedemption, ProvisioningError> {
        let is_platform_invite = token.starts_with(PLATFORM_INVITE_TOKEN_PREFIX);
        let candidates = if is_platform_invite {
            vec![hash_platform_invite_token(token)]
        } else {
            otp_lookup_candidates(&self.resolve_hmac_key()?, token)
        };
        let resolved = resolve_otp_candidate_org(tx, &candidates).await?;

        // Resolve the credential's tenant from the token hash FIRST, then arm the
        // GUC, THEN do the RLS-gated read. `auth_bootstrap_credentials` is FORCE
        // RLS (migration 0035), so as the non-owner `console_rt` role a lookup-by-hash
        // returns ZERO rows until `app.current_org` is set — but the org is what we
        // need to set it. The narrow SECURITY DEFINER resolver
        // `platform_resolve_bootstrap_org` (migration 0038) returns only the
        // credential's org_id, breaking that chicken-and-egg so OTP first sign-in
        // works for ANY tenant. A NULL means the token is unknown: keep the same
        // generic invalid-OTP error (no row), revealing nothing.
        let Some((org_uuid, token_hash)) = resolved else {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        };
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_uuid.to_string())
            .execute(tx.as_mut())
            .await?;

        let locator: Option<(Uuid, Uuid, i16, Vec<u8>)> = sqlx::query_as(
            "SELECT id, user_id, issuance_version, token_hash FROM auth_bootstrap_credentials WHERE token_hash=$1 AND org_id=$2",
        )
        .bind(&token_hash)
        .bind(org_uuid)
        .fetch_optional(tx.as_mut())
        .await?;
        let Some((credential_id, user_id, issuance_version, stored_hash)) = locator else {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        };
        if verify_slices_are_equal(&stored_hash, &token_hash).is_err() {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }
        if issuance_version == 1 {
            // The command role cannot lock `users` directly; this narrow
            // definer takes the same NO KEY UPDATE Account mutex and checks
            // the armed Company without exposing profile columns.
            let active: Option<bool> =
                sqlx::query_scalar("SELECT auth_security.lock_account_for_auth($1,$2)")
                    .bind(org_uuid)
                    .bind(user_id)
                    .fetch_one(tx.as_mut())
                    .await?;
            if active != Some(true) {
                return Err(ProvisioningError::InvalidBootstrapCredential);
            }
        } else {
            require_active_account_tx(tx, OrgId::from_uuid(org_uuid), user_id).await?;
        }
        // Account/security state precedes source-row custody in the lock order.
        // Version 0 remains readable under the existing runtime role; only the
        // dormant version-1 command path needs the private state grant.
        let first_enrollment_state: Option<(i64, Option<bool>, String)> = if issuance_version == 1 {
            sqlx::query_as(
                "SELECT auth_generation, ever_enrolled, status \
                     FROM auth_security.account_state \
                     WHERE account_id=$1 AND home_org_id=$2 FOR SHARE",
            )
            .bind(user_id)
            .bind(org_uuid)
            .fetch_optional(tx.as_mut())
            .await?
        } else {
            None
        };
        let source = sqlx::query(
            "SELECT single_use, expires_at, issuance_version, issued_generation, issuance_purpose, source_operation_id FROM auth_bootstrap_credentials WHERE id=$1 AND user_id=$2 AND org_id=$3 AND token_hash=$4 AND consumed_at IS NULL AND revoked_at IS NULL FOR UPDATE")
            .bind(credential_id).bind(user_id).bind(org_uuid).bind(&token_hash)
            .fetch_optional(tx.as_mut()).await?;
        let source = source.ok_or(ProvisioningError::InvalidBootstrapCredential)?;
        let now = authentication_time_tx(tx, now).await?;
        let expires: OffsetDateTime = source.try_get("expires_at")?;
        if expires <= now {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }

        let single_use = source.try_get::<bool, _>("single_use")?;
        let requires_passkey_setup = count_user_passkeys_tx(tx, user_id).await? == 0;
        // The legacy flag also permits recovery/handoff with existing passkeys.
        if !single_use && !requires_passkey_setup {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }

        let redeemed = sqlx::query(
            "UPDATE auth_bootstrap_credentials SET redeemed_at=$2 WHERE id=$1 \
             AND redeemed_at IS NULL AND consumed_at IS NULL \
             AND revoked_at IS NULL AND expires_at>$2",
        )
        .bind(credential_id)
        .bind(now)
        .execute(tx.as_mut())
        .await?;
        if redeemed.rows_affected() != 1 {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }

        if is_platform_invite && org_uuid == *OrgId::platform().as_uuid() && issuance_version == 0 {
            let has_invites_table: bool = sqlx::query_scalar(
                "SELECT to_regclass('public.platform_operator_invites') IS NOT NULL",
            )
            .fetch_one(tx.as_mut())
            .await?;
            if has_invites_table {
                sqlx::query(
                    "UPDATE platform_operator_invites SET redeemed_at = COALESCE(redeemed_at, $2) \
                     WHERE credential_id = $1 AND user_id = $3 AND org_id = $4 \
                       AND accepted_at IS NULL AND revoked_at IS NULL",
                )
                .bind(credential_id)
                .bind(now)
                .bind(user_id)
                .bind(org_uuid)
                .execute(tx.as_mut())
                .await?;
            }
        }

        if issuance_version == 1 {
            let (generation, ever_enrolled, status) =
                first_enrollment_state.ok_or(ProvisioningError::InvalidBootstrapCredential)?;
            if source.try_get::<i16, _>("issuance_version")? != 1
                || source.try_get::<Option<i64>, _>("issued_generation")? != Some(generation)
                || source.try_get::<Option<&str>, _>("issuance_purpose")?
                    != Some("first_enrollment")
                || source
                    .try_get::<Option<Uuid>, _>("source_operation_id")?
                    .is_none()
                || status != "never_enrolled"
                || ever_enrolled != Some(false)
                || !requires_passkey_setup
            {
                return Err(ProvisioningError::InvalidBootstrapCredential);
            }
            // One-use proof is consumed in the caller's transaction, before it
            // mints a restricted family and finalizes an admission. The public
            // wrapper above refuses to commit this consumption on its own.
            let consumed = sqlx::query(
                "UPDATE auth_bootstrap_credentials SET consumed_at=$1 \
                 WHERE id=$2 AND user_id=$3 AND org_id=$4 AND token_hash=$5 \
                   AND issuance_version=1 AND issued_generation=$6 \
                   AND issuance_purpose='first_enrollment' \
                   AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$1",
            )
            .bind(now)
            .bind(credential_id)
            .bind(user_id)
            .bind(org_uuid)
            .bind(&token_hash)
            .bind(generation)
            .execute(tx.as_mut())
            .await?;
            if consumed.rows_affected() != 1 {
                return Err(ProvisioningError::InvalidBootstrapCredential);
            }
        }

        if issuance_version == 0 {
            let audit = AuditEvent::new(
                Some(UserId::from_uuid(user_id)),
                AuditAction::new("auth.otp.redeem")?,
                "auth_bootstrap_credential",
                credential_id.to_string(),
                TraceContext::generate(),
                now,
            )
            .with_org(OrgId::from_uuid(org_uuid))
            .with_snapshots(
                None,
                Some(serde_json::json!({
                    "user_id": user_id,
                    "requires_passkey_setup": requires_passkey_setup,
                })),
            );
            insert_audit_event(tx, &audit).await?;
        }
        // The version-1 command appends its one source/family/admission-bound
        // audit only after all three agree; it has no general audit INSERT.

        Ok(OtpRedemption {
            user_id,
            org_id: OrgId::from_uuid(org_uuid),
            requires_passkey_setup,
            expires_at: expires,
            reusable: false,
            source: OtpSource {
                credential_id,
                issuance_version: source.try_get("issuance_version")?,
                issued_generation: source.try_get("issued_generation")?,
                issuance_purpose: source.try_get("issuance_purpose")?,
                source_operation_id: source.try_get("source_operation_id")?,
            },
        })
    }
}
