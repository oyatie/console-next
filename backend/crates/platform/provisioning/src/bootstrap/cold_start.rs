use crate::{
    BootstrapCredentialStore, ProvisioningError, hash_token,
    revoke_legacy_otp_families_for_sources_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_auth::authentication_time_tx;
use console_platform_db::with_audits;
use sqlx::{PgPool, Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

impl BootstrapCredentialStore {
    /// Seed a deploy-time cold-start OTP for the PLATFORM cold-start SUPER_ADMIN
    /// at app boot.
    ///
    /// The global `CONSOLE_COLDSTART_OTP` bootstraps the PLATFORM admin — the first
    /// account ABOVE all tenants — NOT a tenant admin. The "Cold Start Admin"
    /// user is re-homed to the platform sentinel org [`OrgId::platform`] by
    /// migration 0036, so this arms that sentinel as the GUC; the seeded
    /// bootstrap credential carries the sentinel org_id. tenant #1's own tenant admin
    /// is created via the per-org onboarding flow (POST /api/platform/orgs), not here.
    ///
    /// ONLY IF that admin has neither a registered passkey nor an already-open
    /// bootstrap credential, this inserts a single bootstrap credential whose
    /// `token_hash = hash_token(otp)` and that expires one TTL after issuance. The insert
    /// is audited via [`with_audits`] (action `auth.coldstart.seed`, target = the
    /// admin user id); the OTP value is NEVER written to the audit snapshot or any
    /// log.
    ///
    /// Returns `Ok(true)` when a credential was seeded and `Ok(false)` when it was
    /// skipped (no cold-start admin, or the admin already has a passkey or an open
    /// credential). Idempotent and race-safe: the existence checks and the insert
    /// run inside one transaction with `FOR UPDATE` on the admin row, exactly like
    /// [`issue_bootstrap_if_needed_tx`], so two concurrent boots cannot double-seed.
    pub async fn seed_cold_start_credential(
        &self,
        pool: &PgPool,
        otp: &str,
        ttl: Duration,
        now: OffsetDateTime,
    ) -> Result<bool, ProvisioningError> {
        let token_hash = hash_token(otp);

        with_audits::<_, bool, ProvisioningError>(pool, OrgId::platform(), |tx| {
            Box::pin(async move {
                match seed_cold_start_if_needed_tx(tx, &token_hash, now, ttl).await? {
                    Some((admin_id, credential_id, issued_at)) => {
                        // The OTP value is NEVER placed in the audit trail; only the
                        // admin id and the new credential id are recorded.
                        let event = AuditEvent::new(
                            Some(UserId::from_uuid(admin_id)),
                            AuditAction::new("auth.coldstart.seed")?,
                            "auth_bootstrap_credential",
                            credential_id.to_string(),
                            TraceContext::generate(),
                            issued_at,
                        )
                        .with_snapshots(None, Some(serde_json::json!({ "user_id": admin_id })));
                        Ok((true, vec![event]))
                    }
                    None => Ok((false, Vec::new())),
                }
            })
        })
        .await
    }
}

/// Seed the cold-start admin's bootstrap credential inside the caller's
/// transaction, if and only if it is needed.
///
/// Returns `Some((admin_id, credential_id))` when a credential was opened and
/// `None` when seeding was skipped (no cold-start admin row, the admin already
/// has a passkey or an open bootstrap credential, or the supplied OTP hash is
/// already in use by another row that cannot be revived). The admin row is locked
/// `FOR UPDATE` so concurrent boots serialize on it and cannot double-seed.
///
/// `token_hash` is globally UNIQUE on `auth_bootstrap_credentials`. On an
/// environment that ran migration 0021 and then 0023, a REVOKED row with the
/// fixed `coss0000` hash still exists; re-seeding the same OTP would collide. The
/// insert is therefore an UPSERT that REVIVES a previously revoked-OR-expired,
/// unconsumed row owned by this same admin (clearing `revoked_at`/`consumed_at`
/// and refreshing the expiry) instead of inserting a duplicate. A conflicting row
/// owned by a different user, one already consumed, or one still valid is left
/// untouched and seeding is reported as skipped.
async fn seed_cold_start_if_needed_tx(
    tx: &mut Transaction<'_, Postgres>,
    token_hash: &[u8],
    now: OffsetDateTime,
    ttl: Duration,
) -> Result<Option<(Uuid, Uuid, OffsetDateTime)>, ProvisioningError> {
    let admin_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM users
        WHERE display_name = 'Cold Start Admin'
          AND roles @> ARRAY['SUPER_ADMIN']::TEXT[]
        ORDER BY id
        LIMIT 1
        FOR UPDATE
        "#,
    )
    .fetch_optional(tx.as_mut())
    .await?;
    // An empty database (squashed baseline, no 0021/0036 rows) has no admin yet. This path
    // only runs when the operator configured a cold-start OTP, so create the platform root
    // here rather than leaving a fresh install with no way to sign in (migration 0241).
    let admin_id = match admin_id {
        Some(id) => id,
        None => {
            sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
                .fetch_one(tx.as_mut())
                .await?
        }
    };
    let now = authentication_time_tx(tx, now).await?;

    let passkey_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(admin_id)
            .fetch_one(tx.as_mut())
            .await?;
    if passkey_count > 0 {
        return Ok(None);
    }

    // Only a still-VALID (unexpired, unconsumed, unrevoked) credential blocks
    // re-seeding. An EXPIRED open row must not wedge cold-start forever: once the
    // short TTL lapses the operator needs a fresh window on the next boot, and the
    // UPSERT below revives that expired row.
    let existing_open: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM auth_bootstrap_credentials
        WHERE user_id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > $2
        LIMIT 1
        "#,
    )
    .bind(admin_id)
    .bind(now)
    .fetch_optional(tx.as_mut())
    .await?;
    if existing_open.is_some() {
        return Ok(None);
    }

    let credential_id = Uuid::new_v4();
    let expires_at = now + ttl;
    // UPSERT on the globally-unique token_hash: a fresh OTP inserts; a previously
    // REVOKED, unconsumed row owned by THIS admin (e.g. the migration-0021/0023
    // coss0000 row) is revived. Any other conflict (different user, or consumed)
    // fails the WHERE, updates nothing, and returns no row -> reported as skipped.
    let opened: Option<(Uuid, OffsetDateTime)> = sqlx::query_as(
        r#"
        INSERT INTO auth_bootstrap_credentials (
            id, user_id, token_hash, issued_at, expires_at, org_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (token_hash) DO UPDATE
            SET issued_at = EXCLUDED.issued_at,
                expires_at = EXCLUDED.expires_at,
                revoked_at = NULL,
                revoked_reason = NULL,
                consumed_at = NULL
            WHERE auth_bootstrap_credentials.user_id = EXCLUDED.user_id
              AND auth_bootstrap_credentials.consumed_at IS NULL
              AND (auth_bootstrap_credentials.revoked_at IS NOT NULL
                   OR auth_bootstrap_credentials.expires_at <= EXCLUDED.issued_at)
        RETURNING id, issued_at
        "#,
    )
    .bind(credential_id)
    .bind(admin_id)
    .bind(token_hash)
    .bind(now)
    .bind(expires_at)
    // The platform admin lives in the platform sentinel org; the credential
    // carries it so the FORCE-RLS WITH CHECK (org_id = GUC) accepts the row.
    .bind(*OrgId::platform().as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;

    // The cold-start seed may revive the same legacy row and token hash. Its
    // previous families must remain dead so an old ceremony cannot inherit the
    // new issuance window.
    if let Some((source_id, _)) = opened {
        revoke_legacy_otp_families_for_sources_tx(
            tx,
            OrgId::platform(),
            admin_id,
            &[source_id],
            now,
        )
        .await?;
    }

    Ok(opened.map(|(credential_id, issued_at)| (admin_id, credential_id, issued_at)))
}
