//! IMPORT-2 (decisions #25): the shell's 주민등록번호 vault. Sealing reuses the
//! webmail envelope AEAD (XChaCha20-Poly1305, per-row key wrapped by a master
//! key) under its own master key; matching is HMAC-SHA256 under a separate
//! key. Both keys come from the environment (Vault-injected in production),
//! never from the database, and are never logged. Without both keys the
//! import drops 주민등록번호 cells and the reveal answers 503.

use console_comms_credential_cipher::{
    Aad, CredentialCipher, EnvelopeCredentialCipher, SealedCredential,
};
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const MASTER_KEY_ENV: &str = "CONSOLE_RRN_MASTER_KEY";
pub const HMAC_KEY_ENV: &str = "CONSOLE_RRN_HMAC_KEY";
const HMAC_KEY_VERSION: i16 = 1;

/// HMAC-SHA256 (RFC 2104) over a key of at most one block.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    block[..key.len().min(64)].copy_from_slice(&key[..key.len().min(64)]);
    let pad = |byte: u8| block.map(|k| k ^ byte);
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize()
        .into()
}

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
        hmac_sha256(&self.hmac_key, rrn.digits().as_bytes()).to_vec()
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

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn hmac_matches_rfc_4231_case_1() {
        assert_eq!(
            hex(&hmac_sha256(&[0x0b; 20], b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
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
            sealed.hmac,
            vault.blind_index(&Rrn::parse("9001011234567").unwrap())
        );
        assert!(!sealed.ciphertext.windows(7).any(|w| w == b"1234567"));
        assert_eq!(vault.open(org, &sealed).unwrap(), rrn);
        assert_eq!(vault.open(other, &sealed), Err(VaultError));
        assert!(EnvRrnVault::from_keys("bad", key).is_err());
    }
}
