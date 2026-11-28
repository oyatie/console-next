// SPDX-License-Identifier: LicenseRef-Proprietary
//! Generation and status queries for 10 single-use HMAC-SHA256 ops recovery codes.

use std::collections::HashSet;

use aws_lc_rs::hmac;
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::with_audits;
use serde::Serialize;
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    BootstrapCredentialStore, OtpHmacKey, ProvisioningError, canonical_otp,
    generate_bootstrap_token,
};

pub const RECOVERY_CODE_COUNT: usize = 10;
const RECOVERY_CODE_DOMAIN: &[u8] = b"console.ops_recovery_code.v1\0";
const RECOVERY_CHALLENGE_DOMAIN: &[u8] = b"console.ops_recovery_challenge.v1\0";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RecoveryCodesSummary {
    pub total: usize,
    pub remaining: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    pub generated_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RecoveryCodesBatch {
    pub batch_id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub generated_at: OffsetDateTime,
    pub codes: Vec<String>,
}

fn keyed_domain_digest(key: &OtpHmacKey, domain: &[u8], canonical_code: &str) -> Vec<u8> {
    let hmac_key = hmac::Key::new(hmac::HMAC_SHA256, key.active_secret_bytes());
    let mut ctx = hmac::Context::with_key(&hmac_key);
    ctx.update(domain);
    ctx.update(canonical_code.as_bytes());
    ctx.sign().as_ref().to_vec()
}

pub fn hash_recovery_code(key: &OtpHmacKey, raw_code: &str) -> Option<Vec<u8>> {
    let canonical = canonical_otp(raw_code)?;
    Some(keyed_domain_digest(key, RECOVERY_CODE_DOMAIN, &canonical))
}

pub fn hash_recovery_challenge(key: &OtpHmacKey, raw_code: &str) -> Option<Vec<u8>> {
    let canonical = canonical_otp(raw_code)?;
    Some(keyed_domain_digest(
        key,
        RECOVERY_CHALLENGE_DOMAIN,
        &canonical,
    ))
}

pub async fn load_recovery_codes_summary_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    user_id: Uuid,
) -> Result<RecoveryCodesSummary, ProvisioningError> {
    let row = sqlx::query(
        "SELECT count(*) FILTER (WHERE consumed_at IS NULL AND revoked_at IS NULL) AS remaining,
                max(generated_at) FILTER (WHERE revoked_at IS NULL) AS generated_at
           FROM recovery_codes
          WHERE org_id = $1 AND user_id = $2",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(RecoveryCodesSummary {
        total: RECOVERY_CODE_COUNT,
        remaining: row.try_get("remaining")?,
        generated_at: row.try_get("generated_at")?,
    })
}

pub async fn generate_recovery_codes_tx(
    tx: &mut Transaction<'_, Postgres>,
    store: &BootstrapCredentialStore,
    org: OrgId,
    user_id: Uuid,
    now: OffsetDateTime,
) -> Result<(RecoveryCodesBatch, Vec<AuditEvent>), ProvisioningError> {
    let hmac_key = store.resolve_hmac_key()?;
    let is_ops: Option<bool> = sqlx::query_scalar(
        "SELECT is_tenant_ops AND is_active FROM users WHERE org_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    if is_ops != Some(true) {
        return Err(ProvisioningError::Forbidden("ops_holder_only".to_owned()));
    }

    let has_contact: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM recovery_contacts WHERE org_id = $1 AND user_id = $2)",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .fetch_one(tx.as_mut())
    .await?;
    if !has_contact {
        return Err(ProvisioningError::Conflict(
            "ops_recovery_contact_missing".to_owned(),
        ));
    }

    let revoked = sqlx::query(
        "UPDATE recovery_codes
            SET revoked_at = $3, revoked_reason = 'regenerated'
          WHERE org_id = $1 AND user_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL",
    )
    .bind(org.as_uuid())
    .bind(user_id)
    .bind(now)
    .execute(tx.as_mut())
    .await?
    .rows_affected();

    let batch_id = Uuid::new_v4();
    let mut codes = Vec::with_capacity(RECOVERY_CODE_COUNT);
    let mut seen_hashes = HashSet::with_capacity(RECOVERY_CODE_COUNT);
    while codes.len() < RECOVERY_CODE_COUNT {
        let token = generate_bootstrap_token()?;
        let code_str = token.as_str().to_owned();
        let Some(code_hash) = hash_recovery_code(&hmac_key, &code_str) else {
            continue;
        };
        if !seen_hashes.insert(code_hash.clone()) {
            continue;
        }
        let slot = i16::try_from(codes.len() + 1).unwrap_or(1);
        sqlx::query(
            "INSERT INTO recovery_codes (org_id, user_id, batch_id, code_index, code_hash, generated_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(org.as_uuid())
        .bind(user_id)
        .bind(batch_id)
        .bind(slot)
        .bind(&code_hash)
        .bind(now)
        .execute(tx.as_mut())
        .await?;
        codes.push(code_str);
    }

    let event = AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new("auth.recovery_codes.generate")?,
        "recovery_codes_batch",
        batch_id.to_string(),
        TraceContext::generate(),
        now,
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "batch_id": batch_id,
            "count": RECOVERY_CODE_COUNT,
            "revoked_previous_count": revoked,
        })),
    );
    Ok((
        RecoveryCodesBatch {
            batch_id,
            generated_at: now,
            codes,
        },
        vec![event],
    ))
}

pub async fn generate_recovery_codes(
    pool: &PgPool,
    store: &BootstrapCredentialStore,
    org: OrgId,
    user_id: Uuid,
    now: OffsetDateTime,
) -> Result<RecoveryCodesBatch, ProvisioningError> {
    let store = store.clone();
    with_audits::<_, RecoveryCodesBatch, ProvisioningError>(pool, org, move |tx| {
        Box::pin(async move { generate_recovery_codes_tx(tx, &store, org, user_id, now).await })
    })
    .await
}
