// SPDX-License-Identifier: LicenseRef-Proprietary
//! SQL queries and DEK generation helpers for `tenant_encryption_keys`.

use std::sync::Arc;

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use console_kernel_core::OrgId;
use console_platform_crypto::{
    CryptoError, KmsProvider, TenantKeyScope, TenantKeyState, WrappedDek, tenant_key_fingerprint,
};
use secrecy::SecretBox;
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::tenant_keys::TenantKeyError;
use crate::with_org_conn;

const DEK_LEN: usize = 32;

#[derive(Clone)]
pub(crate) struct StoredTenantKeyRow {
    pub(crate) key_version: i32,
    pub(crate) state: TenantKeyState,
    pub(crate) kek_id: String,
    pub(crate) wrapped_dek: Option<Vec<u8>>,
}

pub(crate) async fn lock_scope_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: Uuid,
    scope: TenantKeyScope,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("tdek:{org_uuid}:{}", scope.as_str()))
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

pub(crate) async fn fetch_rows(
    pool: &PgPool,
    org: OrgId,
    scope: TenantKeyScope,
) -> Result<Vec<StoredTenantKeyRow>, TenantKeyError> {
    let org_uuid = *org.as_uuid();
    with_org_conn::<_, _, TenantKeyError>(pool, org, move |tx| {
        Box::pin(async move { fetch_rows_tx(tx, org_uuid, scope).await })
    })
    .await
}

pub(crate) async fn fetch_rows_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: Uuid,
    scope: TenantKeyScope,
) -> Result<Vec<StoredTenantKeyRow>, TenantKeyError> {
    let rows = sqlx::query(
        "SELECT key_version, state, kek_id, wrapped_dek \
           FROM tenant_encryption_keys \
          WHERE org_id = $1 AND key_scope = $2 \
          ORDER BY key_version ASC",
    )
    .bind(org_uuid)
    .bind(scope.as_str())
    .fetch_all(tx.as_mut())
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let state_raw: String = row.try_get("state")?;
        out.push(StoredTenantKeyRow {
            key_version: row.try_get("key_version")?,
            state: TenantKeyState::parse(&state_raw)?,
            kek_id: row.try_get("kek_id")?,
            wrapped_dek: row.try_get("wrapped_dek")?,
        });
    }
    Ok(out)
}

pub(crate) type GeneratedWrappedDek = (WrappedDek, Arc<SecretBox<[u8; DEK_LEN]>>, [u8; 32]);

pub(crate) fn generate_wrapped_dek(
    org_uuid: Uuid,
    scope: TenantKeyScope,
    key_version: i32,
    master_kms: &dyn KmsProvider,
) -> Result<GeneratedWrappedDek, TenantKeyError> {
    let rng = SystemRandom::new();
    let mut raw = Zeroizing::new([0u8; DEK_LEN]);
    rng.fill(raw.as_mut())
        .map_err(|_| TenantKeyError::Crypto(CryptoError::Encrypt))?;
    let dek = Arc::new(SecretBox::new(Box::new(*raw)));
    let wrapped = master_kms.wrap_dek(scope.tenant_dek_purpose(), dek.as_ref())?;
    let fp = tenant_key_fingerprint(
        org_uuid,
        scope,
        key_version,
        &wrapped.kek_id,
        &wrapped.ciphertext,
    );
    Ok((wrapped, dek, fp))
}
