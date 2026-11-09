//! IMPORT-2 (decisions #25): the shell's 주민등록번호 vault. Sealing reuses the
//! versioned webmail envelope AEAD (v1 writes during dual-reader rollout) under
//! its own master key; matching is HMAC-SHA256 under a separate
//! key. Both keys come from the environment (Vault-injected in production),
//! never from the database, and are never logged. Without both keys the
//! import drops 주민등록번호 cells and the reveal answers 503.

use aws_lc_rs::hmac;
use console_comms_credential_cipher::{
    Aad, CredentialCipher, EnvelopeCredentialCipher, SealedCredential,
};
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use uuid::Uuid;

pub const MASTER_KEY_ENV: &str = "CONSOLE_RRN_MASTER_KEY";
pub const HMAC_KEY_ENV: &str = "CONSOLE_RRN_HMAC_KEY";
const HMAC_KEY_VERSION: i16 = 1;

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
    hmac_key: Vec<u8>,
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
        Self::from_cipher(cipher, hmac)
    }

    fn from_cipher(cipher: EnvelopeCredentialCipher, hmac: &str) -> Result<Self, String> {
        use base64::Engine as _;
        let hmac_key = base64::engine::general_purpose::STANDARD
            .decode(hmac.trim())
            .ok()
            .filter(|key| key.len() == 32)
            .ok_or_else(|| format!("{HMAC_KEY_ENV} is not a base64 32-byte key"))?;
        Ok(Self { cipher, hmac_key })
    }

    /// `Ok(None)` when neither key is set.
    ///
    /// # Errors
    /// When only one is set, or one is malformed.
    pub fn from_env() -> Result<Option<Self>, String> {
        use crate::config::secret_files::secret_env;
        let master = secret_env(MASTER_KEY_ENV)
            .map_err(|err| err.to_string())?
            .map(EnvelopeCredentialCipher::from_owned_base64_key);
        let hmac = secret_env(HMAC_KEY_ENV).map_err(|err| err.to_string())?;
        match (master, hmac) {
            (None, None) => Ok(None),
            (Some(master), Some(hmac)) => Self::from_cipher(
                master.map_err(|_| format!("{MASTER_KEY_ENV} is not a base64 32-byte key"))?,
                &hmac,
            )
            .map(Some),
            _ => Err(format!(
                "set both {MASTER_KEY_ENV} and {HMAC_KEY_ENV}, or neither"
            )),
        }
    }
}

fn aad(org: &str) -> Aad<'_> {
    Aad {
        org_id: org,
        account_id: "employee_rrn",
        field: "rrn",
    }
}

impl RrnVault for EnvRrnVault {
    fn seal(&self, org: Uuid, rrn: &Rrn) -> Result<SealedRrn, VaultError> {
        let org = org.to_string();
        let sealed = self
            .cipher
            .encrypt(rrn.digits().as_bytes(), aad(&org))
            .map_err(|_| VaultError)?;
        Ok(SealedRrn {
            hmac: self.blind_index(rrn),
            hmac_key_version: HMAC_KEY_VERSION,
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            dek_wrapped: sealed.dek_wrapped,
            dek_nonce: sealed.dek_nonce,
            key_version: sealed.key_version,
            masked: rrn.masked(),
        })
    }

    fn blind_index(&self, rrn: &Rrn) -> Vec<u8> {
        hmac::sign(
            &hmac::Key::new(hmac::HMAC_SHA256, &self.hmac_key),
            rrn.digits().as_bytes(),
        )
        .as_ref()
        .to_vec()
    }

    fn open(&self, org: Uuid, sealed: &SealedRrn) -> Result<Rrn, VaultError> {
        let org = org.to_string();
        let credential = SealedCredential {
            ciphertext: sealed.ciphertext.clone(),
            nonce: sealed.nonce.clone(),
            dek_wrapped: sealed.dek_wrapped.clone(),
            dek_nonce: sealed.dek_nonce.clone(),
            key_version: sealed.key_version,
        };
        let plain = self
            .cipher
            .open_bytes(&credential, aad(&org))
            .map_err(|_| VaultError)?;
        let text = std::str::from_utf8(&plain).map_err(|_| VaultError)?;
        Rrn::parse(text).map_err(|_| VaultError)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

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
        // Captured from the original SHA-256 ipad/opad implementation.
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
        // Literal historical binding, independent of the current vault's aad().
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
            hmac: vault.blind_index(&rrn),
            hmac_key_version: 1,
            ciphertext: credential.ciphertext,
            nonce: credential.nonce,
            dek_wrapped: credential.dek_wrapped,
            dek_nonce: credential.dek_nonce,
            key_version: credential.key_version,
            masked: rrn.masked(),
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
        assert_eq!(
            hex(&sealed.hmac),
            "50ac32b2efe7b34cedaa4452d5048195e05b40e40d5129644fb1dd8ab12bc2bc"
        );
        assert_eq!(
            sealed.hmac,
            vault.blind_index(&Rrn::parse("9001011234567").unwrap())
        );
        assert!(!sealed.ciphertext.windows(7).any(|w| w == b"1234567"));
        assert_eq!(vault.open(org, &sealed).unwrap(), rrn);
        assert_eq!(vault.open(other, &sealed), Err(VaultError));
        assert!(EnvRrnVault::from_keys("bad", key).is_err());
    }
}

#[cfg(all(test, feature = "test-postgres"))]
#[path = "rrn_vault_db_tests.rs"]
mod db_tests;
