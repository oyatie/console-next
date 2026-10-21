use crate::{BootstrapCredentialStore, ProvisioningError, hash_token, resolve_bootstrap_org};
use console_platform_auth::{RefreshTokenIssue, RefreshTokenStore, authentication_time_tx};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// A separate pool authenticated as the restricted authentication command
/// role. The role is still NOLOGIN in the default topology; provisioning a
/// distinct credential and routing traffic are later cutover operations.
#[derive(Clone)]
pub struct FirstEnrollmentCommandPool {
    pool: PgPool,
}

#[derive(Debug)]
pub enum FirstEnrollmentOutcome {
    /// A local PostgreSQL commit only. The bearer stays internal and must not
    /// be acknowledged or released until a future two-site confirmation
    /// barrier and purpose-aware validator cutover both succeed.
    LocallyCommitted {
        receipt_id: Uuid,
        refresh: RefreshTokenIssue,
        enrollment_expires_at: OffsetDateTime,
    },
    /// Local committed status only. The bearer is deliberately unavailable on
    /// replay: only its hash exists; this is not a two-site acknowledgment.
    AlreadyCommitted { receipt_id: Uuid },
}

impl FirstEnrollmentCommandPool {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Consume exactly one v1 first-enrollment proof, issue only an enrollment
    /// family, finalize the operation receipt and append a fixed audit in one
    /// transaction. The client holds `operation_id` and a random status secret
    /// before calling; only the secret's SHA-256 hash reaches this method.
    /// There is intentionally no HTTP caller until purpose-aware validation,
    /// recovery and old-process fencing have passed their separate gates.
    pub async fn admit(
        &self,
        otp: &str,
        operation_id: Uuid,
        status_secret_hash: [u8; 32],
        trusted_now: OffsetDateTime,
    ) -> Result<FirstEnrollmentOutcome, ProvisioningError> {
        let mut tx = self.pool.begin().await?;
        let role: String = sqlx::query_scalar("SELECT current_user")
            .fetch_one(tx.as_mut())
            .await?;
        if role != "console_auth_cmd" {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }
        let token_hash = hash_token(otp);
        let org_uuid = resolve_bootstrap_org(&mut tx, &token_hash)
            .await?
            .ok_or(ProvisioningError::InvalidBootstrapCredential)?;
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org_uuid.to_string())
            .execute(tx.as_mut())
            .await?;
        let source = sqlx::query(
            "SELECT id,user_id,issued_generation,source_operation_id,expires_at \
                 FROM auth_bootstrap_credentials \
                 WHERE org_id=$1 AND token_hash=$2 AND issuance_version=1",
        )
        .bind(org_uuid)
        .bind(&token_hash)
        .fetch_optional(tx.as_mut())
        .await?;
        let source = source.ok_or(ProvisioningError::InvalidBootstrapCredential)?;
        let source_id: Uuid = source.try_get("id")?;
        let user_id: Uuid = source.try_get("user_id")?;
        let source_generation: Option<i64> = source.try_get("issued_generation")?;
        let source_operation: Option<Uuid> = source.try_get("source_operation_id")?;
        let source_expires_at: OffsetDateTime = source.try_get("expires_at")?;
        let active: Option<bool> =
            sqlx::query_scalar("SELECT auth_security.lock_account_for_auth($1,$2)")
                .bind(org_uuid)
                .bind(user_id)
                .fetch_one(tx.as_mut())
                .await?;
        if active != Some(true) {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }

        // The source token identifies a Company, but only the locked Account
        // and same-Company private state authorize an admission. A committed
        // retry can return its receipt without minting another bearer.
        let existing = sqlx::query(
            "SELECT status_secret_hash,status,receipt_id,source_row_id,account_id, \
                 session_purpose,auth_generation,source_operation_id,family_id \
                 FROM auth_security.session_admissions \
                 WHERE operation_id=$1 AND home_org_id=$2 FOR UPDATE",
        )
        .bind(operation_id)
        .bind(org_uuid)
        .fetch_optional(tx.as_mut())
        .await?;
        if let Some(existing) = existing {
            let saved_hash: Vec<u8> = existing.try_get("status_secret_hash")?;
            let receipt_id: Option<Uuid> = existing.try_get("receipt_id")?;
            let saved_source: Option<Uuid> = existing.try_get("source_row_id")?;
            let saved_account: Uuid = existing.try_get("account_id")?;
            let generation: i64 = existing.try_get("auth_generation")?;
            let issuance: Option<Uuid> = existing.try_get("source_operation_id")?;
            let family: Option<Uuid> = existing.try_get("family_id")?;
            if saved_hash.as_slice() == status_secret_hash.as_slice()
                && existing.try_get::<&str, _>("status")? == "committed"
                && saved_source == Some(source_id)
                && saved_account == user_id
                && existing.try_get::<&str, _>("session_purpose")? == "enrollment"
                && Some(generation) == source_generation
                && issuance == source_operation
                && family.is_some()
                && let Some(receipt_id) = receipt_id
            {
                tx.commit().await?;
                return Ok(FirstEnrollmentOutcome::AlreadyCommitted { receipt_id });
            }
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }

        let state: Option<(i64, Option<bool>, String)> = sqlx::query_as(
            "SELECT auth_generation,ever_enrolled,status \
             FROM auth_security.account_state \
             WHERE account_id=$1 AND home_org_id=$2 FOR SHARE",
        )
        .bind(user_id)
        .bind(org_uuid)
        .fetch_optional(tx.as_mut())
        .await?;
        let Some((generation, Some(false), status)) = state else {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        };
        if status != "never_enrolled" || source_generation != Some(generation) {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }
        let source_operation =
            source_operation.ok_or(ProvisioningError::InvalidBootstrapCredential)?;
        let now = authentication_time_tx(&mut tx, trusted_now).await?;
        // This original deadline is stored once. Refresh or challenge renewal
        // cannot extend it when those paths are later switched to version 1.
        let deadline = source_expires_at.min(now + Duration::minutes(15));
        if deadline <= now + Duration::seconds(1) {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }
        sqlx::query(
            "INSERT INTO auth_security.session_admissions \
             (operation_id,status_secret_hash,account_id,home_org_id,auth_generation,session_purpose,expires_at) \
             VALUES($1,$2,$3,$4,$5,'enrollment',$6)",
        )
        .bind(operation_id)
        .bind(status_secret_hash.as_slice())
        .bind(user_id)
        .bind(org_uuid)
        .bind(generation)
        .bind(deadline)
        .execute(tx.as_mut())
        .await?;

        let proof = BootstrapCredentialStore
            .redeem_otp_in_tx(&mut tx, otp, now)
            .await?;
        if proof.source.issuance_version != 1
            || proof.source.credential_id != source_id
            || proof.source.issued_generation != Some(generation)
            || proof.source.source_operation_id != Some(source_operation)
            || proof.user_id != user_id
            || *proof.org_id.as_uuid() != org_uuid
        {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }
        let refresh = RefreshTokenStore
            .issue_first_enrollment_family_in_tx(
                &mut tx,
                user_id,
                proof.org_id,
                generation,
                operation_id,
                deadline,
            )
            .await?;
        let completed_at = authentication_time_tx(&mut tx, now).await?;
        let receipt_id = Uuid::new_v4();
        let committed = sqlx::query(
            "UPDATE auth_security.session_admissions \
             SET status='committed',source_kind='bootstrap_otp',source_row_id=$2, \
                 source_operation_id=$3,family_id=$4,receipt_id=$5,finalized_at=$6 \
             WHERE operation_id=$1 AND account_id=$7 AND home_org_id=$8 \
               AND auth_generation=$9 AND status='pending' AND expires_at>$6",
        )
        .bind(operation_id)
        .bind(source_id)
        .bind(source_operation)
        .bind(refresh.family_id)
        .bind(receipt_id)
        .bind(completed_at)
        .bind(user_id)
        .bind(org_uuid)
        .bind(generation)
        .execute(tx.as_mut())
        .await?;
        if committed.rows_affected() != 1 {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }
        sqlx::query("SELECT auth_security.append_first_enrollment_audit($1)")
            .bind(operation_id)
            .execute(tx.as_mut())
            .await?;
        tx.commit().await?;
        Ok(FirstEnrollmentOutcome::LocallyCommitted {
            receipt_id,
            refresh,
            enrollment_expires_at: deadline,
        })
    }
}
