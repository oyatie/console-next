// SPDX-License-Identifier: LicenseRef-Proprietary
//! Per-tenant DEK-resolving `CredentialCipher` wrapper for worker/CLI reseal
//! and legacy census operations.

use std::sync::Arc;

use console_comms_application::credential_cipher::{
    ScopedCredentialCipherFuture, SecretBox, TargetKekForOrgFuture,
};
use console_comms_application::{Aad, CipherError, CredentialCipher, SealedCredential};
use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_kernel_core::OrgId;
use console_platform_crypto::{TenantDekMode, TenantKeyScope};
use console_platform_db::tenant_keys::PgTenantKeyStore;
use sqlx::PgPool;
use uuid::Uuid;

/// Wraps [`EnvelopeCredentialCipher`] with a [`PgTenantKeyStore`] so
/// `reseal_email_accounts` and `legacy_envelope_census_with_cipher` resolve
/// per-tenant DEKs at async org boundaries.
#[derive(Debug, Clone)]
pub struct TenantEnvMailCipher {
    inner: Arc<EnvelopeCredentialCipher>,
    pool: PgPool,
    store: Arc<PgTenantKeyStore>,
}

impl TenantEnvMailCipher {
    #[must_use]
    pub fn new(inner: Arc<EnvelopeCredentialCipher>, pool: PgPool) -> Self {
        let mode = match TenantDekMode::from_env() {
            Ok(mode) => mode,
            Err(_) => {
                tracing::warn!("invalid CONSOLE_TENANT_DEK_MODE value; defaulting to active");
                TenantDekMode::Active
            }
        };
        Self {
            inner,
            pool,
            store: Arc::new(PgTenantKeyStore::new(mode)),
        }
    }
}

impl CredentialCipher for TenantEnvMailCipher {
    fn encrypt(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError> {
        CredentialCipher::encrypt(self.inner.as_ref(), plaintext, aad)
    }

    fn decrypt(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SecretBox<Vec<u8>>, CipherError> {
        CredentialCipher::decrypt(self.inner.as_ref(), sealed, aad)
    }

    fn active_alg_id(&self) -> Option<&str> {
        CredentialCipher::active_alg_id(self.inner.as_ref())
    }

    fn active_kek_id(&self) -> Option<&str> {
        CredentialCipher::active_kek_id(self.inner.as_ref())
    }

    fn reseal(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SealedCredential, CipherError> {
        CredentialCipher::reseal(self.inner.as_ref(), sealed, aad)
    }

    fn scoped_for_org<'a>(&'a self, org: Uuid) -> ScopedCredentialCipherFuture<'a> {
        Box::pin(async move {
            let kms = self
                .store
                .load_scope_for_org(
                    &self.pool,
                    OrgId::from_uuid(org),
                    TenantKeyScope::Mail,
                    Arc::clone(self.inner.kms_provider()),
                )
                .await
                .map_err(|_| CipherError::MasterKey)?;
            Ok(Some(
                Arc::new(self.inner.with_tenant_kms(Arc::new(kms))) as Arc<dyn CredentialCipher>
            ))
        })
    }

    fn target_kek_for_org<'a>(&'a self, org: Uuid) -> TargetKekForOrgFuture<'a> {
        Box::pin(async move {
            self.store
                .active_target_kek_for_org(
                    &self.pool,
                    OrgId::from_uuid(org),
                    TenantKeyScope::Mail,
                    self.inner.kms_provider().as_ref(),
                )
                .await
                .map_err(|_| CipherError::MasterKey)
        })
    }
}
