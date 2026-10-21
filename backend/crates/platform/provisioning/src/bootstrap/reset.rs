use crate::{
    BootstrapCredentialIssue, BootstrapCredentialStore, IssueMode, ProvisioningError,
    issue_bootstrap_if_needed_tx, require_active_account_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::with_audits;
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

impl BootstrapCredentialStore {
    /// Admin account-recovery escape hatch: revoke ALL of a user's passkeys AND
    /// mint a fresh single-use bootstrap OTP, ATOMICALLY and AUDITED, so a user who
    /// lost their only passkey can re-enroll.
    ///
    /// The normal admin-OTP path ([`Self::issue_for_zero_credential_user`]) refuses
    /// a user who already has a passkey (returns [`ProvisioningError::UserAlreadyHasPasskey`]),
    /// and self-revoke refuses the last passkey, so neither can recover a locked-out
    /// user. This method is the deliberate, admin-only override.
    ///
    /// Behaviour in ONE transaction (tenant `org` armed as `app.current_org` by
    /// `with_audits`, so every FORCE-RLS read/write/delete on the target's
    /// `auth_webauthn_credentials` and `auth_bootstrap_credentials` is scoped to the
    /// caller's tenant — a user in another org is invisible and cannot be reset):
    ///   1. DELETE every `auth_webauthn_credentials` row for `user_id`, each audited
    ///      as `auth.passkey.admin_reset`. The old passkeys then fail login.
    ///   2. Mint a fresh bootstrap OTP via [`issue_bootstrap_if_needed_tx`] in
    ///      [`IssueMode::ForceReset`] (bypasses the now-stale passkey check and
    ///      revokes any leftover open code), audited as `auth.otp.issue`.
    ///
    ///   3. Revoke every live refresh-token family of the user (and bump its
    ///      `session_generation`), audited as `auth.refresh.revoke_all`: a
    ///      session the lost device still holds dies with its passkey, so the
    ///      new OTP is the only way back in.
    ///
    /// Every audit row names `actor` (the resetting admin); the target is the
    /// row's target/snapshot.
    ///
    /// Returns the one-time OTP exactly like [`Self::issue_for_zero_credential_user`]
    /// so the admin can hand it to the user. The OTP value is NEVER audited or logged.
    pub async fn reset_credentials_for_user(
        &self,
        pool: &PgPool,
        actor: UserId,
        user_id: Uuid,
        org: OrgId,
        now: OffsetDateTime,
        ttl: Duration,
    ) -> Result<BootstrapCredentialIssue, ProvisioningError> {
        with_audits::<_, BootstrapCredentialIssue, ProvisioningError>(pool, org, |tx| {
            Box::pin(async move {
                require_active_account_tx(tx, org, user_id).await?;
                // (1) Revoke ALL of the target's passkeys. RETURNING the row ids so
                // each deletion is audited individually. The GUC armed by
                // `with_audits` scopes this DELETE to the caller's tenant, so a user
                // in another org matches zero rows (cross-org reset is a no-op +
                // generic "user not found" surfaced by the REST layer's prior read).
                let deleted = sqlx::query(
                    r#"
                    DELETE FROM auth_webauthn_credentials
                    WHERE user_id = $1
                    RETURNING id, credential_id
                    "#,
                )
                .bind(user_id)
                .fetch_all(tx.as_mut())
                .await?;

                let mut events = Vec::with_capacity(deleted.len() + 1);
                for row in deleted {
                    let credential_uuid: Uuid = row.try_get("id")?;
                    let credential_id: String = row.try_get("credential_id")?;
                    events.push(
                        AuditEvent::new(
                            Some(actor),
                            AuditAction::new("auth.passkey.admin_reset")?,
                            "auth_webauthn_credential",
                            credential_uuid.to_string(),
                            TraceContext::generate(),
                            now,
                        )
                        .with_org(org)
                        .with_snapshots(
                            Some(serde_json::json!({
                                "credential_id": credential_id,
                                "user_id": user_id,
                            })),
                            None,
                        ),
                    );
                }

                // (2) Mint a fresh single-use OTP. ForceReset bypasses the
                // passkey-existence rejection (the rows were just deleted in this same
                // transaction) and revokes any stale open code so the new OTP is the
                // user's sole valid recovery credential.
                let issue =
                    issue_bootstrap_if_needed_tx(tx, user_id, org, now, ttl, IssueMode::ForceReset)
                        .await?
                        .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)?;

                events.push(
                    AuditEvent::new(
                        Some(actor),
                        AuditAction::new("auth.otp.issue")?,
                        "auth_bootstrap_credential",
                        issue.credential_id.to_string(),
                        TraceContext::generate(),
                        now,
                    )
                    .with_org(org)
                    .with_snapshots(
                        None,
                        Some(serde_json::json!({
                            "user_id": user_id,
                            "expires_at": issue.expires_at,
                            "reason": "admin_reset",
                        })),
                    ),
                );

                // (3) End every session the old passkeys created: the family
                // revocation fails each access token's live-family check and
                // every refresh; the generation bump fences the tokens too.
                let revoked_families = sqlx::query(
                    "UPDATE auth_refresh_token_families \
                     SET revoked_at = $3, revoked_reason = 'credential_reset' \
                     WHERE user_id = $1 AND org_id = $2 AND revoked_at IS NULL",
                )
                .bind(user_id)
                .bind(*org.as_uuid())
                .bind(now)
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                sqlx::query(
                    "UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, $3) \
                     WHERE user_id = $1 AND org_id = $2",
                )
                .bind(user_id)
                .bind(*org.as_uuid())
                .bind(now)
                .execute(tx.as_mut())
                .await?;
                sqlx::query(
                    "INSERT INTO subject_authz_versions (org_id, user_id, version, session_generation, updated_at) \
                     VALUES ($1, $2, 1, 1, $3) \
                     ON CONFLICT (org_id, user_id) DO UPDATE \
                     SET session_generation = subject_authz_versions.session_generation + 1, \
                         updated_at = EXCLUDED.updated_at",
                )
                .bind(*org.as_uuid())
                .bind(user_id)
                .bind(now)
                .execute(tx.as_mut())
                .await?;
                events.push(
                    AuditEvent::new(
                        Some(actor),
                        AuditAction::new("auth.refresh.revoke_all")?,
                        "user",
                        user_id.to_string(),
                        TraceContext::generate(),
                        now,
                    )
                    .with_org(org)
                    .with_snapshots(
                        None,
                        Some(serde_json::json!({
                            "user_id": user_id,
                            "reason": "credential_reset",
                            "revoked_family_count": revoked_families,
                        })),
                    ),
                );

                Ok((issue, events))
            })
        })
        .await
    }

    /// Cross-device SELF passkey-enrollment handoff: mint a fresh single-use,
    /// short-TTL one-time code for the CURRENTLY AUTHENTICATED user so they can
    /// finish passkey enrollment on a SECOND device (typically a phone scanning a
    /// QR on the desktop console). The returned code is scoped to THAT SAME user
    /// and is redeemed through the ordinary `/auth/otp/redeem` first-sign-in path
    /// on the phone, which lands the phone on its own onboarding page to enroll a
    /// platform passkey — no Bluetooth / caBLE hybrid tunnel involved.
    ///
    /// This NEVER mints a handoff for another user: `user_id` and `org` are taken
    /// from the caller's VERIFIED access token at the REST layer, never from the
    /// request body, so a caller can only ever hand off to itself.
    ///
    /// Issuance semantics ([`IssueMode::ForceReset`], but WITHOUT touching
    /// passkeys — the REST layer enforces the step-up gate for an already-enrolled
    /// user before calling this):
    ///   * A user MID-ONBOARDING (just redeemed, zero passkeys) typically already
    ///     holds one OPEN bootstrap code (the one they redeemed; it is consumed
    ///     only at passkey registration). The partial-unique
    ///     `idx_auth_bootstrap_credentials_one_open_per_user` permits only ONE open
    ///     code per user, so this REVOKES that stale open code (reason `reset`) and
    ///     mints a fresh one in its place. The original code therefore stops
    ///     working the moment a handoff is issued — at most one live code exists.
    ///   * A user ADDING A DEVICE (already has a passkey) gets a fresh handoff code
    ///     too; `ForceReset` bypasses the passkey-existence rejection that the
    ///     admin path uses, but does NOT delete any passkey.
    ///
    /// The TTL is SHORT (the caller passes e.g. 5 min — distinct from the 4h admin
    /// OTP) to keep the credential-handoff window tight. The code value is NEVER
    /// audited or logged; only the issuance event (action
    /// `auth.passkey.enroll_handoff_issued`, target = the user) is recorded, armed
    /// to the caller's tenant so the FORCE-RLS WITH CHECK accepts the new row.
    pub async fn issue_self_enroll_handoff(
        &self,
        pool: &PgPool,
        user_id: Uuid,
        org: OrgId,
        now: OffsetDateTime,
        ttl: Duration,
    ) -> Result<BootstrapCredentialIssue, ProvisioningError> {
        with_audits::<_, BootstrapCredentialIssue, ProvisioningError>(pool, org, |tx| {
            Box::pin(async move {
                // ForceReset: revoke any stale OPEN code for this user and mint a
                // fresh one, WITHOUT requiring (or deleting) passkeys. Works both
                // mid-onboarding (an open redeemed code is superseded) and for an
                // already-enrolled add-device user (no open code -> clean insert).
                let issue =
                    issue_bootstrap_if_needed_tx(tx, user_id, org, now, ttl, IssueMode::ForceReset)
                        .await?
                        .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)?;

                let event = AuditEvent::new(
                    Some(UserId::from_uuid(user_id)),
                    AuditAction::new("auth.passkey.enroll_handoff_issued")?,
                    "auth_bootstrap_credential",
                    issue.credential_id.to_string(),
                    TraceContext::generate(),
                    now,
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(serde_json::json!({
                        "user_id": user_id,
                        "expires_at": issue.expires_at,
                        "purpose": "passkey_enrollment_handoff",
                    })),
                );

                Ok((issue, vec![event]))
            })
        })
        .await
    }
}
