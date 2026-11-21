// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant DEK rotation and O(tenants) master KEK re-wrapping helpers.

use std::sync::Arc;

use console_kernel_core::{
    AuditAction, AuditEvent, AuditSource, OrgId, Timestamp, TraceContext, UserId,
};
use console_platform_crypto::{
    AlgId, KekId, KmsProvider, TenantKeyScope, TenantKeyState, tenant_key_fingerprint,
};
use serde_json::json;
use sqlx::{PgPool, Row};

use crate::tenant_keys::{PgTenantKeyStore, TenantKeyError};
use crate::tenant_keys_sql::{fetch_rows_tx, generate_wrapped_dek, lock_scope_tx};
use crate::with_audits;

impl PgTenantKeyStore {
    /// Rotate the tenant DEK for `(org, scope)`, retiring any prior `ACTIVE`
    /// version and creating `version + 1` inside `with_audits`.
    pub async fn rotate_tenant_dek(
        &self,
        pool: &PgPool,
        org: OrgId,
        scope: TenantKeyScope,
        master_kms: Arc<dyn KmsProvider>,
        actor: Option<UserId>,
    ) -> Result<i32, TenantKeyError> {
        let org_uuid = *org.as_uuid();
        let cache = Arc::clone(&self.cache);
        let (ver, wrapped, dek) = with_audits::<_, _, TenantKeyError>(pool, org, move |tx| {
            Box::pin(async move {
                lock_scope_tx(tx, org_uuid, scope).await?;
                let existing = fetch_rows_tx(tx, org_uuid, scope).await?;
                if existing.iter().any(|r| r.state == TenantKeyState::Shredded) {
                    return Err(TenantKeyError::Shredded);
                }
                let prev_ver = existing
                    .iter()
                    .find(|r| r.state == TenantKeyState::Active)
                    .map(|r| r.key_version);
                let next_ver = existing
                    .iter()
                    .map(|r| r.key_version)
                    .max()
                    .unwrap_or(0)
                    .saturating_add(1);

                sqlx::query(
                    "UPDATE tenant_encryption_keys \
                        SET state = 'RETIRED', retired_at = now() \
                      WHERE org_id = $1 AND key_scope = $2 AND state = 'ACTIVE'",
                )
                .bind(org_uuid)
                .bind(scope.as_str())
                .execute(tx.as_mut())
                .await?;

                let (wrapped, dek, fp) =
                    generate_wrapped_dek(org_uuid, scope, next_ver, master_kms.as_ref())?;
                let alg_id = AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap.as_str();
                let master_kek_id = wrapped.kek_id.as_str().to_owned();
                sqlx::query(
                    "INSERT INTO tenant_encryption_keys \
                     (org_id, key_scope, key_version, state, alg_id, kek_id, wrapped_dek, key_fingerprint) \
                     VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, $7)",
                )
                .bind(org_uuid)
                .bind(scope.as_str())
                .bind(next_ver)
                .bind(alg_id)
                .bind(&master_kek_id)
                .bind(&wrapped.ciphertext)
                .bind(fp.as_slice())
                .execute(tx.as_mut())
                .await?;

                let event = AuditEvent::new(
                    actor,
                    AuditAction::new("platform.tenant_key.rotate")?,
                    "organization",
                    org_uuid.to_string(),
                    TraceContext::generate(),
                    Timestamp::now_utc(),
                )
                .with_source(AuditSource::System)
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "scope": scope.as_str(),
                        "from_key_version": prev_ver,
                        "to_key_version": next_ver,
                        "master_kek_id": master_kek_id,
                    })),
                );
                Ok(((next_ver, wrapped.ciphertext, dek), vec![event]))
            })
        })
        .await?;

        cache.insert(org_uuid, scope, ver, &wrapped, dek);
        Ok(ver)
    }

    /// Re-wrap `tenant_encryption_keys` rows for `org` onto `master_kms.active_kek_id()`
    /// without changing tenant DEK versions or re-sealing row ciphertexts.
    pub async fn rewrap_master_kek_batch(
        &self,
        pool: &PgPool,
        org: OrgId,
        master_kms: Arc<dyn KmsProvider>,
        limit: i64,
    ) -> Result<usize, TenantKeyError> {
        self.rewrap_master_kek_inner(pool, org, None, master_kms, limit)
            .await
    }

    /// Re-wrap `tenant_encryption_keys` rows for `(org, scope)` onto
    /// `master_kms.active_kek_id()` without touching other key scopes.
    pub async fn rewrap_master_kek_scope_batch(
        &self,
        pool: &PgPool,
        org: OrgId,
        scope: TenantKeyScope,
        master_kms: Arc<dyn KmsProvider>,
        limit: i64,
    ) -> Result<usize, TenantKeyError> {
        self.rewrap_master_kek_inner(pool, org, Some(scope), master_kms, limit)
            .await
    }

    async fn rewrap_master_kek_inner(
        &self,
        pool: &PgPool,
        org: OrgId,
        scope_filter: Option<TenantKeyScope>,
        master_kms: Arc<dyn KmsProvider>,
        limit: i64,
    ) -> Result<usize, TenantKeyError> {
        if limit <= 0 {
            return Ok(0);
        }
        let org_uuid = *org.as_uuid();
        let target_kek = master_kms.active_kek_id().as_str().to_owned();
        let scope_str = scope_filter.map(|s| s.as_str().to_owned());
        let cache = Arc::clone(&self.cache);
        let updated_items = with_audits::<_, _, TenantKeyError>(pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    "SELECT key_scope, key_version, kek_id, wrapped_dek \
                       FROM tenant_encryption_keys \
                      WHERE org_id = $1 AND state IN ('ACTIVE', 'RETIRED') \
                        AND ($4::text IS NULL OR key_scope = $4) \
                        AND kek_id IS DISTINCT FROM $2 \
                      ORDER BY key_scope, key_version \
                      LIMIT $3 FOR UPDATE SKIP LOCKED",
                )
                .bind(org_uuid)
                .bind(&target_kek)
                .bind(limit)
                .bind(scope_str.as_deref())
                .fetch_all(tx.as_mut())
                .await?;
                if rows.is_empty() {
                    return Ok((Vec::new(), Vec::new()));
                }

                let mut updates = Vec::with_capacity(rows.len());
                let mut from_keks = Vec::new();
                for row in &rows {
                    let scope_raw: String = row.try_get("key_scope")?;
                    let scope = TenantKeyScope::parse(&scope_raw)?;
                    let key_version: i32 = row.try_get("key_version")?;
                    let old_kek_raw: String = row.try_get("kek_id")?;
                    let old_wrapped: Vec<u8> = row.try_get("wrapped_dek")?;
                    let old_kek = KekId::new(&old_kek_raw)?;
                    let dek = Arc::new(master_kms.unwrap_dek(
                        &old_kek,
                        scope.tenant_dek_purpose(),
                        &old_wrapped,
                    )?);
                    let rewrapped =
                        master_kms.wrap_dek(scope.tenant_dek_purpose(), dek.as_ref())?;
                    let fp = tenant_key_fingerprint(
                        org_uuid,
                        scope,
                        key_version,
                        &rewrapped.kek_id,
                        &rewrapped.ciphertext,
                    );
                    sqlx::query(
                        "UPDATE tenant_encryption_keys \
                            SET alg_id = $4, kek_id = $5, wrapped_dek = $6, key_fingerprint = $7 \
                          WHERE org_id = $1 AND key_scope = $2 AND key_version = $3",
                    )
                    .bind(org_uuid)
                    .bind(scope.as_str())
                    .bind(key_version)
                    .bind(AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap.as_str())
                    .bind(rewrapped.kek_id.as_str())
                    .bind(&rewrapped.ciphertext)
                    .bind(fp.as_slice())
                    .execute(tx.as_mut())
                    .await?;
                    from_keks.push(old_kek_raw);
                    updates.push((scope, key_version, rewrapped.ciphertext, dek));
                }

                let event = AuditEvent::new(
                    None,
                    AuditAction::new("platform.tenant_key.rewrap")?,
                    "organization",
                    org_uuid.to_string(),
                    TraceContext::generate(),
                    Timestamp::now_utc(),
                )
                .with_source(AuditSource::Scheduler)
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "updated": updates.len(),
                        "from_master_keks": from_keks,
                        "to_master_kek": target_kek,
                    })),
                );
                Ok((updates, vec![event]))
            })
        })
        .await?;

        let count = updated_items.len();
        for (scope, ver, wrapped, dek) in updated_items {
            cache.insert(org_uuid, scope, ver, &wrapped, dek);
        }
        Ok(count)
    }
}
