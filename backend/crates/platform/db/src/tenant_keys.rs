// SPDX-License-Identifier: LicenseRef-Proprietary
//! RLS-armed PostgreSQL store for per-tenant DEKs (`tenant_encryption_keys`).

use std::collections::BTreeMap;
use std::sync::Arc;

use console_kernel_core::{
    AuditAction, AuditEvent, AuditSource, KernelError, OrgId, Timestamp, TraceContext,
};
use console_platform_crypto::{
    AlgId, CryptoError, KekId, KmsProvider, TenantDekCache, TenantDekMode, TenantKekId,
    TenantKeyScope, TenantKeyState, TenantScopedKms,
};
use serde_json::json;
use sqlx::PgPool;

use crate::tenant_keys_sql::{fetch_rows, fetch_rows_tx, generate_wrapped_dek, lock_scope_tx};
use crate::{DbError, with_audits};

/// Failures while loading, provisioning, rotating, or re-wrapping tenant DEKs.
#[derive(Debug, thiserror::Error)]
pub enum TenantKeyError {
    #[error("tenant encryption key database error: {0}")]
    Db(#[from] DbError),
    #[error("tenant encryption key crypto error: {0}")]
    Crypto(#[from] CryptoError),
    #[error("tenant encryption key audit error: {0}")]
    Kernel(#[from] KernelError),
    #[error("tenant encryption keys have been cryptographically shredded")]
    Shredded,
}

impl From<sqlx::Error> for TenantKeyError {
    fn from(err: sqlx::Error) -> Self {
        Self::Db(DbError::from(err))
    }
}

/// RLS-armed store and hash-verified DEK cache for `tenant_encryption_keys`.
#[derive(Debug, Clone)]
pub struct PgTenantKeyStore {
    pub(crate) cache: Arc<TenantDekCache>,
    pub(crate) mode: TenantDekMode,
}

impl Default for PgTenantKeyStore {
    fn default() -> Self {
        Self::new(TenantDekMode::Active)
    }
}

impl PgTenantKeyStore {
    #[must_use]
    pub fn new(mode: TenantDekMode) -> Self {
        Self {
            cache: Arc::new(TenantDekCache::new()),
            mode,
        }
    }

    #[must_use]
    pub fn with_cache(cache: Arc<TenantDekCache>, mode: TenantDekMode) -> Self {
        Self { cache, mode }
    }

    #[must_use]
    pub fn cache(&self) -> &Arc<TenantDekCache> {
        &self.cache
    }

    #[must_use]
    pub const fn mode(&self) -> TenantDekMode {
        self.mode
    }

    /// Resolve a [`TenantScopedKms`] for `(org, scope)` under `with_org_conn`,
    /// lazily provisioning `v1` in [`TenantDekMode::Active`] if unprovisioned and
    /// never auto-reprovisioning a `SHREDDED` tenant.
    pub async fn load_scope_for_org(
        &self,
        pool: &PgPool,
        org: OrgId,
        scope: TenantKeyScope,
        master_kms: Arc<dyn KmsProvider>,
    ) -> Result<TenantScopedKms, TenantKeyError> {
        let org_uuid = *org.as_uuid();
        let mut rows = fetch_rows(pool, org, scope).await?;
        if rows.iter().any(|r| r.state == TenantKeyState::Shredded) {
            self.cache.evict_org(org_uuid);
            return Ok(TenantScopedKms::from_resolved(
                org_uuid,
                scope,
                None,
                true,
                BTreeMap::new(),
                master_kms,
            ));
        }

        let has_active = rows.iter().any(|r| r.state == TenantKeyState::Active);
        if !has_active && self.mode == TenantDekMode::Active {
            self.ensure_active_dek(pool, org, scope, Arc::clone(&master_kms))
                .await?;
            rows = fetch_rows(pool, org, scope).await?;
            if rows.iter().any(|r| r.state == TenantKeyState::Shredded) {
                self.cache.evict_org(org_uuid);
                return Ok(TenantScopedKms::from_resolved(
                    org_uuid,
                    scope,
                    None,
                    true,
                    BTreeMap::new(),
                    master_kms,
                ));
            }
        }

        let mut active_version = None;
        let mut tenant_deks = BTreeMap::new();
        for row in rows {
            if row.state == TenantKeyState::Shredded {
                continue;
            }
            if row.state == TenantKeyState::Active {
                active_version = Some(row.key_version);
            }
            let Some(wrapped) = row.wrapped_dek.as_deref() else {
                return Err(TenantKeyError::Crypto(CryptoError::Decrypt));
            };
            let dek = if let Some(cached) =
                self.cache
                    .get_if_hash_matches(org_uuid, scope, row.key_version, wrapped)
            {
                cached
            } else {
                let master_kek = KekId::new(row.kek_id)?;
                let unwrapped = Arc::new(master_kms.unwrap_dek(
                    &master_kek,
                    scope.tenant_dek_purpose(),
                    wrapped,
                )?);
                self.cache.insert(
                    org_uuid,
                    scope,
                    row.key_version,
                    wrapped,
                    Arc::clone(&unwrapped),
                );
                unwrapped
            };
            tenant_deks.insert(row.key_version, dek);
        }

        let writer_version = match self.mode {
            TenantDekMode::Active => active_version,
            TenantDekMode::DualRead => None,
        };
        Ok(TenantScopedKms::from_resolved(
            org_uuid,
            scope,
            writer_version,
            false,
            tenant_deks,
            master_kms,
        ))
    }

    /// Resolve the active target `kek_id` for `(org, scope)` without provisioning
    /// a new row (returns `None` when shredded).
    pub async fn active_target_kek_for_org(
        &self,
        pool: &PgPool,
        org: OrgId,
        scope: TenantKeyScope,
        master_kms: &dyn KmsProvider,
    ) -> Result<Option<String>, TenantKeyError> {
        let rows = fetch_rows(pool, org, scope).await?;
        if rows.iter().any(|r| r.state == TenantKeyState::Shredded) {
            return Ok(None);
        }
        match self.mode {
            TenantDekMode::DualRead => Ok(Some(master_kms.active_kek_id().as_str().to_owned())),
            TenantDekMode::Active => {
                let ver = rows
                    .iter()
                    .find(|r| r.state == TenantKeyState::Active)
                    .map_or(1, |r| r.key_version);
                Ok(Some(
                    TenantKekId {
                        org_id: *org.as_uuid(),
                        scope,
                        key_version: ver,
                    }
                    .to_kek_id()
                    .to_string(),
                ))
            }
        }
    }

    async fn ensure_active_dek(
        &self,
        pool: &PgPool,
        org: OrgId,
        scope: TenantKeyScope,
        master_kms: Arc<dyn KmsProvider>,
    ) -> Result<(), TenantKeyError> {
        let org_uuid = *org.as_uuid();
        let cache = Arc::clone(&self.cache);
        let inserted = with_audits::<_, _, TenantKeyError>(pool, org, move |tx| {
            Box::pin(async move {
                lock_scope_tx(tx, org_uuid, scope).await?;
                let existing = fetch_rows_tx(tx, org_uuid, scope).await?;
                if existing.iter().any(|r| r.state == TenantKeyState::Shredded) {
                    return Err(TenantKeyError::Shredded);
                }
                if existing.iter().any(|r| r.state == TenantKeyState::Active) {
                    return Ok((None, Vec::new()));
                }
                let next_ver = existing
                    .iter()
                    .map(|r| r.key_version)
                    .max()
                    .unwrap_or(0)
                    .saturating_add(1);
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
                    None,
                    AuditAction::new("platform.tenant_key.provision")?,
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
                        "key_version": next_ver,
                        "alg_id": alg_id,
                        "master_kek_id": master_kek_id,
                    })),
                );
                Ok((Some((next_ver, wrapped.ciphertext, dek)), vec![event]))
            })
        })
        .await?;

        if let Some((ver, wrapped, dek)) = inserted {
            cache.insert(org_uuid, scope, ver, &wrapped, dek);
        }
        Ok(())
    }
}
