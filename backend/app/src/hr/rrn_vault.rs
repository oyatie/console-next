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
    let rrn_vault = from_env_logged();
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

/// The vault for the HR router, or none (logged once per router build; the
/// message names the variables, never a value).
pub fn from_env_logged() -> Option<std::sync::Arc<dyn RrnVault>> {
    match EnvRrnVault::from_env() {
        Ok(Some(vault)) => Some(std::sync::Arc::new(vault)),
        Ok(None) => {
            tracing::info!(
                "{MASTER_KEY_ENV}/{HMAC_KEY_ENV} unset: imports drop 주민등록번호 cells and the reveal answers 503"
            );
            None
        }
        Err(message) => {
            tracing::error!("{message}: 주민등록번호 handling is off");
            None
        }
    }
}

pub struct EnvRrnVault {
    cipher: EnvelopeCredentialCipher,
    hmac_ring: BlindIndexKeyring,
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
    /// The vault from the two keys (base64 of 32 bytes each).
    ///
    /// # Errors
    /// A message naming the variable (never its value) when one is malformed.
    #[cfg(test)]
    pub fn from_keys(master: &str, hmac: &str) -> Result<Self, String> {
        let cipher = EnvelopeCredentialCipher::from_base64_key(master)
            .map_err(|_| format!("{MASTER_KEY_ENV} is not a base64 32-byte key"))?;
        let hmac_ring = BlindIndexKeyring::from_single_legacy_base64(hmac)
            .map_err(|_| format!("{HMAC_KEY_ENV} is not a base64 32-byte key"))?;
        Ok(Self { cipher, hmac_ring })
    }

    /// Build a vault from optional keyring JSON and legacy base64 secrets.
    ///
    /// # Errors
    /// A message naming the variable (never its value) when one is malformed.
    #[cfg(test)]
    pub fn from_keyrings(
        master_keyring: Option<&str>,
        legacy_master: Option<&str>,
        hmac_keyring: Option<&str>,
        legacy_hmac: Option<&str>,
    ) -> Result<Self, String> {
        let cipher = EnvelopeCredentialCipher::from_owned_env_values(
            master_keyring.map(str::to_owned),
            legacy_master.map(str::to_owned),
        )
        .map_err(|_| format!("{MASTER_KEY_ENV}/{KEYRING_ENV} is invalid"))?
        .ok_or_else(|| format!("{MASTER_KEY_ENV}/{KEYRING_ENV} unset"))?;
        let hmac_ring = BlindIndexKeyring::from_owned_env_values(
            hmac_keyring.map(str::to_owned),
            legacy_hmac.map(str::to_owned),
        )
        .map_err(|_| format!("{HMAC_KEY_ENV}/{HMAC_KEYRING_ENV} is invalid"))?
        .ok_or_else(|| format!("{HMAC_KEY_ENV}/{HMAC_KEYRING_ENV} unset"))?;
        Ok(Self { cipher, hmac_ring })
    }

    #[cfg(test)]
    #[must_use]
    pub fn from_provider(
        kms: std::sync::Arc<dyn console_platform_crypto::KmsProvider>,
        hmac_ring: BlindIndexKeyring,
    ) -> Self {
        Self {
            cipher: EnvelopeCredentialCipher::from_provider(kms),
            hmac_ring,
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
        let cipher = EnvelopeCredentialCipher::from_owned_env_values(keyring, master)
            .map_err(|_| format!("{MASTER_KEY_ENV}/{KEYRING_ENV} is invalid"))?;
        let hmac_ring = BlindIndexKeyring::from_owned_env_values(hmac_keyring, hmac)
            .map_err(|_| format!("{HMAC_KEY_ENV}/{HMAC_KEYRING_ENV} is invalid"))?;
        match (cipher, hmac_ring) {
            (None, None) => Ok(None),
            (Some(cipher), Some(hmac_ring)) => Ok(Some(Self { cipher, hmac_ring })),
            _ => Err(format!(
                "set both {MASTER_KEY_ENV}/{KEYRING_ENV} and {HMAC_KEY_ENV}/{HMAC_KEYRING_ENV}, or neither"
            )),
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
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use aws_lc_rs::hmac;

    fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
        hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), message)
            .as_ref()
            .to_vec()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn hmac_preserves_existing_32_byte_key_indexes() {
        for (key, message, expected) in [
            (
                [0u8; 32],
                b"".as_slice(),
                "b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad",
            ),
            (
                [7u8; 32],
                b"synthetic identity",
                "d4c969fedc30197c0f4e3cf0d03f34b132b08585e4205488cf9e3999a699dfbf",
            ),
        ] {
            assert_eq!(hex(&hmac_sha256(&key, message)), expected);
        }
    }

    #[test]
    fn hmac_matches_rfc_4231_case_1() {
        assert_eq!(
            hex(&hmac_sha256(&[0x0b; 20], b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn historical_v1_rrn_binding_remains_readable() {
        use base64::Engine as _;
        let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        let vault = EnvRrnVault::from_keys(&key, &key).unwrap();
        let org = Uuid::new_v4();
        let rrn = Rrn::parse("900101-1234567").unwrap();
        let credential = vault
            .cipher
            .encrypt_with_suite(
                1,
                rrn.digits().as_bytes(),
                Aad {
                    org_id: &org.to_string(),
                    account_id: "employee_rrn",
                    field: "rrn",
                },
            )
            .unwrap();
        let sealed = SealedRrn {
            hmac: vault.blind_index_v1(&rrn),
            hmac_key_version: 1,
            hmac_v2: None,
            blind_index_version: None,
            ciphertext: credential.ciphertext,
            nonce: credential.nonce,
            dek_wrapped: credential.dek_wrapped,
            dek_nonce: credential.dek_nonce,
            key_version: credential.key_version,
            masked: rrn.masked(),
            alg_id: credential.alg_id,
            kek_id: credential.kek_id,
            msg_id: credential.msg_id,
            commitment_tag: credential.commitment_tag,
        };
        assert_eq!(sealed.key_version, 1);
        assert_eq!(vault.open(org, &sealed).unwrap(), rrn);
        assert_eq!(vault.open(Uuid::new_v4(), &sealed), Err(VaultError));
    }

    #[test]
    fn a_sealed_number_opens_only_for_its_tenant_and_matches_by_hash() {
        let key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let vault = EnvRrnVault::from_keys(key, key).unwrap();
        let (org, other) = (Uuid::new_v4(), Uuid::new_v4());
        let rrn = Rrn::parse("900101-1234567").unwrap();
        let sealed = vault.seal(org, &rrn).unwrap();
        assert_eq!(sealed.masked, "900101-1******");
        assert_eq!(sealed.hmac_key_version, 1);
        assert_eq!(
            hex(&sealed.hmac),
            "50ac32b2efe7b34cedaa4452d5048195e05b40e40d5129644fb1dd8ab12bc2bc"
        );
        assert_eq!(sealed.blind_index_version, Some(2));
        let normalized = Rrn::parse("9001011234567").unwrap();
        assert_eq!(sealed.hmac_v2, Some(vault.blind_index(org, &normalized)));
        assert_ne!(vault.blind_index(org, &rrn), vault.blind_index(other, &rrn));
        assert_ne!(sealed.hmac_v2.as_deref(), Some(sealed.hmac.as_slice()));
        assert!(!sealed.ciphertext.windows(7).any(|w| w == b"1234567"));
        assert_eq!(vault.open(org, &sealed).unwrap(), rrn);
        assert_eq!(vault.open(other, &sealed), Err(VaultError));
        assert!(EnvRrnVault::from_keys("bad", key).is_err());

        let provider = std::sync::Arc::new(
            console_platform_crypto::LocalKeyringProvider::from_single_base64(
                console_platform_crypto::KekId::legacy_default(),
                key,
            )
            .unwrap(),
        );
        let hmac_ring = BlindIndexKeyring::from_single_legacy_base64(key).unwrap();
        let pv = EnvRrnVault::from_provider(provider, hmac_ring);
        let pv_sealed = pv.seal(org, &rrn).unwrap();
        assert_eq!(pv.open(org, &pv_sealed).unwrap(), rrn);
        assert_eq!(pv.active_kek_id(), Some("legacy-env-v1"));
        assert_eq!(
            pv.active_alg_id(),
            Some("aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp")
        );
        let pv_resealed = pv.reseal(org, &pv_sealed).unwrap();
        assert_eq!(pv.open(org, &pv_resealed).unwrap(), rrn);
    }
}

#[cfg(test)]
#[path = "rrn_vault_v2_tests.rs"]
mod v2_tests;

#[cfg(all(test, feature = "test-postgres"))]
#[path = "rrn_vault_db_tests.rs"]
mod db_tests;
