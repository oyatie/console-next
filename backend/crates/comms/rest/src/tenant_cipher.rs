// SPDX-License-Identifier: LicenseRef-Proprietary
//! Per-tenant DEK resolution for mail REST handlers.

use std::sync::Arc;

use console_comms_credential_cipher::EnvelopeCredentialCipher;
use console_kernel_core::OrgId;
use console_platform_crypto::{TenantDekMode, TenantKeyScope};
use console_platform_db::tenant_keys::PgTenantKeyStore;

use crate::{CommsRestState, RestError};

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

impl CommsRestState {
    /// Override the per-tenant DEK store (primarily for N-1 / cache tests).
    #[must_use]
    pub fn with_tenant_keys(mut self, tenant_keys: Arc<PgTenantKeyStore>) -> Self {
        self.tenant_keys = tenant_keys;
        self
    }

    /// Borrow the cipher or fail with a 503 when the master key is unconfigured.
    pub(crate) fn cipher_ref(&self) -> Result<&EnvelopeCredentialCipher, RestError> {
        self.cipher
            .as_deref()
            .ok_or_else(RestError::email_not_configured)
    }
}

pub(crate) async fn resolve_tenant_cipher(
    state: &CommsRestState,
    org_id: OrgId,
) -> Result<Arc<EnvelopeCredentialCipher>, RestError> {
    let base = state.cipher_ref()?;
    let kms = state
        .tenant_keys
        .load_scope_for_org(
            state.pool(),
            org_id,
            TenantKeyScope::Mail,
            Arc::clone(base.kms_provider()),
        )
        .await
        .map_err(|_| RestError::unavailable("tenant encryption key is unavailable"))?;
    Ok(Arc::new(base.with_tenant_kms(Arc::new(kms))))
}
