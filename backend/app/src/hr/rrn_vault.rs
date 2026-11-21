//! IMPORT-2 (decisions #25): the shell's resident registration number vault. Sealing uses the
//! versioned webmail envelope AEAD (`v3` AWS-ESDK-v2 default writer, retaining `v1`/`v2`
//! readers for N-1 rollback) under its own master key; matching uses tenant-bound
//! HKDF-SHA256 + HMAC-SHA256 blind indexes (v2+) while retaining legacy v1 compatibility
//! during backfill. Both keys come from the environment (Vault-injected in production), never
//! from the database, and are never logged.

use console_comms_credential_cipher::{
    Aad, CURRENT_KEY_VERSION, CredentialCipher, EnvelopeCredentialCipher, SealedCredential,
};
use console_hr_adapter_postgres::HrService;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use console_platform_auth::JwtVerifier;
use console_platform_crypto::{BlindIndexContext, BlindIndexKeyring, LEGACY_HMAC_KEY_VERSION};
use sqlx::PgPool;
use uuid::Uuid;

pub(super) fn new_hr_state(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> super::HrState {
    let rrn_vault = crate::rrn_vault_tenant::from_env_logged_for_pool(pool.clone());
    super::HrState {
        hr: HrService::new(pool.clone()).with_rrn_vault(rrn_vault.clone()),
        pool,
        leave_command_store: None,
        jwt_verifier,
        passkey_step_up: None,
        rrn_vault,
    }
}

impl super::HrState {
    #[must_use]
    pub fn with_rrn_vault(mut self, rrn_vault: Option<std::sync::Arc<dyn RrnVault>>) -> Self {
        self.hr = self.hr.with_rrn_vault(rrn_vault.clone());
        self.rrn_vault = rrn_vault;
        self
    }
}

pub const MASTER_KEY_ENV: &str = "CONSOLE_RRN_MASTER_KEY";
pub const KEYRING_ENV: &str = "CONSOLE_RRN_KEYRING";
pub const HMAC_KEY_ENV: &str = "CONSOLE_RRN_HMAC_KEY";
pub const HMAC_KEYRING_ENV: &str = "CONSOLE_RRN_HMAC_KEYRING";
const BLIND_INDEX_TABLE: &str = "employee_rrn";
const BLIND_INDEX_FIELD: &str = "rrn";

pub struct EnvRrnVault {
    cipher: EnvelopeCredentialCipher,
    hmac_ring: std::sync::Arc<BlindIndexKeyring>,
    tenant_keys: Option<(
        PgPool,
        std::sync::Arc<console_platform_db::tenant_keys::PgTenantKeyStore>,
    )>,
}

impl std::fmt::Debug for EnvRrnVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnvRrnVault")
            .field("cipher", &self.cipher)
            .field("hmac_ring", &self.hmac_ring)
            .finish()
    }
}

impl EnvRrnVault {
    /// Construct from explicit owned keyring/legacy strings (for integration tests).
    pub fn from_owned_values(
        keyring: Option<String>,
        master: Option<String>,
        hmac_keyring: Option<String>,
        hmac: Option<String>,
    ) -> Result<Option<Self>, String> {
        crate::rrn_vault_tenant::from_owned_values(keyring, master, hmac_keyring, hmac)
    }

    pub(crate) fn from_parts(
        cipher: EnvelopeCredentialCipher,
        hmac_ring: BlindIndexKeyring,
    ) -> Self {
        Self {
            cipher,
            hmac_ring: std::sync::Arc::new(hmac_ring),
            tenant_keys: None,
        }
    }

    /// `Ok(None)` when neither key is set.
    ///
    /// # Errors
    /// When only one is set, or one is malformed.
    pub fn from_env() -> Result<Option<Self>, String> {
        use crate::config::secret_files::secret_env;
        let keyring = secret_env(KEYRING_ENV).map_err(|err| err.to_string())?;
        let master = secret_env(MASTER_KEY_ENV).map_err(|err| err.to_string())?;
        let hmac_keyring = secret_env(HMAC_KEYRING_ENV).map_err(|err| err.to_string())?;
        let hmac = secret_env(HMAC_KEY_ENV).map_err(|err| err.to_string())?;
        Self::from_owned_values(keyring, master, hmac_keyring, hmac)
    }

    /// Attach a per-tenant DEK store so async callers resolve tenant-scoped DEKs.
    #[must_use]
    pub fn with_tenant_keys(
        mut self,
        pool: PgPool,
        store: std::sync::Arc<console_platform_db::tenant_keys::PgTenantKeyStore>,
    ) -> Self {
        self.tenant_keys = Some((pool, store));
        self
    }

    pub(crate) fn tenant_keys(
        &self,
    ) -> Option<&(
        PgPool,
        std::sync::Arc<console_platform_db::tenant_keys::PgTenantKeyStore>,
    )> {
        self.tenant_keys.as_ref()
    }

    pub(crate) fn cipher_ref(&self) -> &EnvelopeCredentialCipher {
        &self.cipher
    }

    pub(crate) fn with_tenant_kms(
        &self,
        kms: std::sync::Arc<dyn console_platform_crypto::KmsProvider>,
    ) -> Self {
        Self {
            cipher: self.cipher.with_tenant_kms(kms),
            hmac_ring: std::sync::Arc::clone(&self.hmac_ring),
            tenant_keys: None,
        }
    }
}

fn aad(org: &str) -> Aad<'_> {
    Aad {
        org_id: org,
        account_id: BLIND_INDEX_TABLE,
        field: BLIND_INDEX_FIELD,
    }
}

fn blind_ctx(org: Uuid) -> BlindIndexContext<'static> {
    BlindIndexContext {
        org_id: org,
        table: BLIND_INDEX_TABLE,
        field: BLIND_INDEX_FIELD,
    }
}

impl RrnVault for EnvRrnVault {
    fn seal(&self, org: Uuid, rrn: &Rrn) -> Result<SealedRrn, VaultError> {
        let org_str = org.to_string();
        let sealed = self
            .cipher
            .encrypt(rrn.digits().as_bytes(), aad(&org_str))
            .map_err(|_| VaultError)?;
        let ctx = blind_ctx(org);
        let digits = rrn.digits().as_bytes();
        let (active_ver, active_digest) = self
            .hmac_ring
            .compute_active(ctx, digits)
            .map_err(|_| VaultError)?;
        let (hmac, hmac_key_version) = if self.hmac_ring.has_version(LEGACY_HMAC_KEY_VERSION) {
            let v1 = self
                .hmac_ring
                .compute_for_version(LEGACY_HMAC_KEY_VERSION, ctx, digits)
                .map_err(|_| VaultError)?;
            (v1.to_vec(), LEGACY_HMAC_KEY_VERSION)
        } else {
            (active_digest.to_vec(), active_ver)
        };
        let (hmac_v2, blind_index_version) = if active_ver >= 2 {
            (Some(active_digest.to_vec()), Some(active_ver))
        } else {
            (None, None)
        };
        Ok(SealedRrn {
            hmac,
            hmac_key_version,
            hmac_v2,
            blind_index_version,
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            dek_wrapped: sealed.dek_wrapped,
            dek_nonce: sealed.dek_nonce,
            key_version: sealed.key_version,
            masked: rrn.masked(),
            alg_id: sealed.alg_id,
            kek_id: sealed.kek_id,
            msg_id: sealed.msg_id,
            commitment_tag: sealed.commitment_tag,
        })
    }

    fn blind_index(&self, org: Uuid, rrn: &Rrn) -> Vec<u8> {
        let ctx = blind_ctx(org);
        let digits = rrn.digits().as_bytes();
        if self.hmac_ring.active_version() >= 2
            && let Ok((_, digest)) = self.hmac_ring.compute_active(ctx, digits)
        {
            return digest.to_vec();
        }
        if let Ok(candidates) = self.hmac_ring.compute_v2_candidates(ctx, digits)
            && let Some((_, digest)) = candidates.first()
        {
            return digest.to_vec();
        }
        self.hmac_ring
            .compute_active(ctx, digits)
            .map(|(_, d)| d.to_vec())
            .unwrap_or_default()
    }

    fn blind_index_v1(&self, rrn: &Rrn) -> Vec<u8> {
        if !self.hmac_ring.has_version(LEGACY_HMAC_KEY_VERSION) {
            return Vec::new();
        }
        self.hmac_ring
            .compute_for_version(
                LEGACY_HMAC_KEY_VERSION,
                blind_ctx(Uuid::nil()),
                rrn.digits().as_bytes(),
            )
            .map(|d| d.to_vec())
            .unwrap_or_default()
    }

    fn active_blind_index_version(&self) -> i16 {
        self.hmac_ring.active_version()
    }

    fn blind_index_v2_candidates(&self, org: Uuid, rrn: &Rrn) -> Vec<Vec<u8>> {
        let Ok(candidates) = self
            .hmac_ring
            .compute_v2_candidates(blind_ctx(org), rrn.digits().as_bytes())
        else {
            return Vec::new();
        };
        let active = self.hmac_ring.active_version();
        let mut out = Vec::with_capacity(candidates.len());
        if active >= 2
            && let Some((_, digest)) = candidates.iter().find(|(v, _)| *v == active)
        {
            out.push(digest.to_vec());
        }
        for (ver, digest) in candidates {
            if ver != active {
                out.push(digest.to_vec());
            }
        }
        out
    }

    fn active_envelope_key_version(&self) -> i16 {
        CURRENT_KEY_VERSION
    }

    fn active_alg_id(&self) -> Option<&str> {
        Some(self.cipher.active_alg_id().as_str())
    }

    fn active_kek_id(&self) -> Option<&str> {
        Some(self.cipher.active_kek_id().as_str())
    }

    fn reseal(&self, org: Uuid, sealed: &SealedRrn) -> Result<SealedRrn, VaultError> {
        let org_str = org.to_string();
        let credential = SealedCredential {
            ciphertext: sealed.ciphertext.clone(),
            nonce: sealed.nonce.clone(),
            dek_wrapped: sealed.dek_wrapped.clone(),
            dek_nonce: sealed.dek_nonce.clone(),
            key_version: sealed.key_version,
            alg_id: sealed.alg_id.clone(),
            kek_id: sealed.kek_id.clone(),
            msg_id: sealed.msg_id.clone(),
            commitment_tag: sealed.commitment_tag.clone(),
        };
        let fresh = self
            .cipher
            .reseal(&credential, aad(&org_str))
            .map_err(|_| VaultError)?;
        Ok(SealedRrn {
            hmac: sealed.hmac.clone(),
            hmac_key_version: sealed.hmac_key_version,
            hmac_v2: sealed.hmac_v2.clone(),
            blind_index_version: sealed.blind_index_version,
            ciphertext: fresh.ciphertext,
            nonce: fresh.nonce,
            dek_wrapped: fresh.dek_wrapped,
            dek_nonce: fresh.dek_nonce,
            key_version: fresh.key_version,
            masked: sealed.masked.clone(),
            alg_id: fresh.alg_id,
            kek_id: fresh.kek_id,
            msg_id: fresh.msg_id,
            commitment_tag: fresh.commitment_tag,
        })
    }

    fn open(&self, org: Uuid, sealed: &SealedRrn) -> Result<Rrn, VaultError> {
        let org_str = org.to_string();
        let credential = SealedCredential {
            ciphertext: sealed.ciphertext.clone(),
            nonce: sealed.nonce.clone(),
            dek_wrapped: sealed.dek_wrapped.clone(),
            dek_nonce: sealed.dek_nonce.clone(),
            key_version: sealed.key_version,
            alg_id: sealed.alg_id.clone(),
            kek_id: sealed.kek_id.clone(),
            msg_id: sealed.msg_id.clone(),
            commitment_tag: sealed.commitment_tag.clone(),
        };
        self.cipher
            .open_with(&credential, aad(&org_str), |plain| {
                let text = std::str::from_utf8(plain).map_err(|_| VaultError)?;
                Rrn::parse(text).map_err(|_| VaultError)
            })
            .map_err(|_| VaultError)?
    }

    fn scoped_for_org<'a>(
        &'a self,
        org: Uuid,
    ) -> console_hr_domain::import::rrn_value::ScopedRrnVaultFuture<'a> {
        Box::pin(crate::rrn_vault_tenant::scoped_for_org(self, org))
    }

    fn target_kek_for_org<'a>(
        &'a self,
        org: Uuid,
    ) -> console_hr_domain::import::rrn_value::TargetRrnKekFuture<'a> {
        Box::pin(crate::rrn_vault_tenant::target_kek_for_org(self, org))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
#[path = "rrn_vault_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "rrn_vault_v2_tests.rs"]
mod v2_tests;

#[cfg(all(test, feature = "test-postgres"))]
#[path = "rrn_vault_db_tests.rs"]
mod db_tests;
