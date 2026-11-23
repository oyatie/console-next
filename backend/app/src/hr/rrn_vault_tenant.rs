// SPDX-License-Identifier: LicenseRef-Proprietary
//! Per-tenant DEK store resolution for the HR RRN vault.

use std::sync::Arc;

use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_hr_domain::import::rrn_value::{RrnVault, VaultError};
use console_kernel_core::OrgId;
use console_platform_crypto::{BlindIndexKeyring, TenantDekMode, TenantKeyScope};
use console_platform_db::tenant_keys::PgTenantKeyStore;
use sqlx::PgPool;
use uuid::Uuid;

use crate::hr::rrn_vault::{
    EnvRrnVault, HMAC_KEY_ENV, HMAC_KEYRING_ENV, KEYRING_ENV, MASTER_KEY_ENV,
};

pub(crate) fn from_owned_values(
    keyring: Option<String>,
    master: Option<String>,
    hmac_keyring: Option<String>,
    hmac: Option<String>,
) -> Result<Option<EnvRrnVault>, String> {
    let cipher = EnvelopeCredentialCipher::from_owned_env_values(keyring, master)
        .map_err(|_| format!("{MASTER_KEY_ENV}/{KEYRING_ENV} is invalid"))?;
    let hmac_ring = BlindIndexKeyring::from_owned_env_values(hmac_keyring, hmac)
        .map_err(|_| format!("{HMAC_KEY_ENV}/{HMAC_KEYRING_ENV} is invalid"))?;
    match (cipher, hmac_ring) {
        (None, None) => Ok(None),
        (Some(cipher), Some(hmac_ring)) => Ok(Some(EnvRrnVault::from_parts(cipher, hmac_ring))),
        _ => Err(format!(
            "set both {MASTER_KEY_ENV}/{KEYRING_ENV} and {HMAC_KEY_ENV}/{HMAC_KEYRING_ENV}, or neither"
        )),
    }
}

pub(crate) fn new_tenant_keys_from_env() -> Arc<PgTenantKeyStore> {
    let mode = match TenantDekMode::from_env() {
        Ok(mode) => mode,
        Err(_) => {
            tracing::warn!("invalid CONSOLE_TENANT_DEK_MODE value; defaulting to active");
            TenantDekMode::Active
        }
    };
    Arc::new(PgTenantKeyStore::new(mode))
}

pub(crate) fn from_env_logged_for_pool(pool: PgPool) -> Option<Arc<dyn RrnVault>> {
    match EnvRrnVault::from_env() {
        Ok(Some(vault)) => Some(Arc::new(
            vault.with_tenant_keys(pool, new_tenant_keys_from_env()),
        )),
        Ok(None) => {
            tracing::info!(
                "{MASTER_KEY_ENV}/{HMAC_KEY_ENV} unset: imports drop RRN cells and reveal answers 503"
            );
            None
        }
        Err(message) => {
            tracing::error!("{message}: RRN handling is off");
            None
        }
    }
}

pub(super) async fn scoped_for_org(
    vault: &EnvRrnVault,
    org: Uuid,
) -> Result<Option<Arc<dyn RrnVault>>, VaultError> {
    let Some((pool, store)) = vault.tenant_keys() else {
        return Ok(None);
    };
    let kms = store
        .load_scope_for_org(
            pool,
            OrgId::from_uuid(org),
            TenantKeyScope::Rrn,
            Arc::clone(vault.cipher_ref().kms_provider()),
        )
        .await
        .map_err(|_| VaultError)?;
    Ok(Some(Arc::new(vault.with_tenant_kms(Arc::new(kms)))))
}

pub(super) async fn target_kek_for_org(
    vault: &EnvRrnVault,
    org: Uuid,
) -> Result<Option<String>, VaultError> {
    let Some((pool, store)) = vault.tenant_keys() else {
        return Ok(vault.active_kek_id().map(str::to_owned));
    };
    store
        .active_target_kek_for_org(
            pool,
            OrgId::from_uuid(org),
            TenantKeyScope::Rrn,
            vault.cipher_ref().kms_provider().as_ref(),
        )
        .await
        .map_err(|_| VaultError)
}
