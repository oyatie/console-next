//! Webmail credential cipher — envelope AEAD for SMTP/IMAP passwords and RRN vault at rest.
//!
//! Version 1 reads and writes XChaCha20-Poly1305 envelopes during rollout.
//! Version 2 reads legacy AES-256-GCM + raw AES-256-KWP envelopes.
//! Version 3 implements AWS-ESDK-v2 key-committing AEAD via `console-platform-crypto`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod legacy;
mod reseal;

use core::fmt;
use std::sync::Arc;

use console_platform_crypto::{
    AlgId, CryptoError, EnvelopeContext, EnvelopeHeader, KekId, KmsProvider, LocalKeyringProvider,
    SealedEnvelope, open_v3, seal_v3,
};
use secrecy::{ExposeSecret, SecretBox};
use zeroize::Zeroizing;

pub use console_comms_application::credential_cipher::{
    Aad, CipherError, CredentialCipher, SealedCredential,
};

/// The environment variable carrying the base64-encoded 32-byte master KEK.
pub const MASTER_KEY_ENV: &str = "CONSOLE_MAIL_MASTER_KEY";
/// The environment variable carrying the JSON multi-key rotation ring.
pub const KEYRING_ENV: &str = "CONSOLE_MAIL_KEYRING";

/// Default envelope writer uses AWS-ESDK-v2 (`alg_id = 3`); v1/v2 readers remain enabled for N-1 rollback.
pub const CURRENT_KEY_VERSION: i16 = 3;

const KEY_LEN: usize = legacy::KEY_LEN;

/// Versioned envelope cipher backed by a [`KmsProvider`] and optional local keyring.
pub struct EnvelopeCredentialCipher {
    kms: Arc<dyn KmsProvider>,
    legacy_ring: Option<Arc<LocalKeyringProvider>>,
}

impl fmt::Debug for EnvelopeCredentialCipher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EnvelopeCredentialCipher")
            .field("active_kek_id", &self.kms.active_kek_id().as_str())
            .field("has_legacy_ring", &self.legacy_ring.is_some())
            .finish()
    }
}

impl EnvelopeCredentialCipher {
    /// Build the cipher from `CONSOLE_MAIL_KEYRING` and/or `CONSOLE_MAIL_MASTER_KEY`.
    pub fn from_env() -> Result<Self, CipherError> {
        let keyring = std::env::var(KEYRING_ENV).ok().map(Zeroizing::new);
        let master = std::env::var(MASTER_KEY_ENV).ok().map(Zeroizing::new);
        Self::from_env_values(keyring, master)?.ok_or(CipherError::MasterKey)
    }

    /// Build from optional keyring JSON and/or legacy base64 master key strings.
    pub fn from_env_values(
        keyring_json: Option<Zeroizing<String>>,
        master_b64: Option<Zeroizing<String>>,
    ) -> Result<Option<Self>, CipherError> {
        let Some(ring) = LocalKeyringProvider::from_env_values(keyring_json, master_b64)
            .map_err(|_| CipherError::MasterKey)?
        else {
            return Ok(None);
        };
        Ok(Some(Self::from_local_keyring(ring)))
    }

    /// Consume optional owned keyring JSON and/or legacy base64 master key strings,
    /// zeroizing them after parsing.
    pub fn from_owned_env_values(
        keyring_json: Option<String>,
        master_b64: Option<String>,
    ) -> Result<Option<Self>, CipherError> {
        Self::from_env_values(
            keyring_json.map(Zeroizing::new),
            master_b64.map(Zeroizing::new),
        )
    }

    /// Wrap a [`LocalKeyringProvider`] for v1, v2, and v3 envelope operations.
    #[must_use]
    pub fn from_local_keyring(ring: LocalKeyringProvider) -> Self {
        let arc = Arc::new(ring);
        Self {
            kms: arc.clone(),
            legacy_ring: Some(arc),
        }
    }

    /// Wrap an arbitrary [`KmsProvider`] (supports v3 AWS-ESDK-v2 envelopes).
    #[must_use]
    pub fn from_provider(kms: Arc<dyn KmsProvider>) -> Self {
        Self {
            kms,
            legacy_ring: None,
        }
    }

    /// Borrow the active [`KmsProvider`].
    #[must_use]
    pub fn kms_provider(&self) -> &Arc<dyn KmsProvider> {
        &self.kms
    }

    /// Return a tenant-scoped copy that delegates `v3` sealing/unwrapping to
    /// `kms` while preserving `legacy_ring` for `v1`/`v2` dual-read when unshredded.
    #[must_use]
    pub fn with_tenant_kms(&self, kms: Arc<dyn KmsProvider>) -> Self {
        let legacy_ring = if kms.is_shredded() {
            None
        } else {
            self.legacy_ring.clone()
        };
        Self { kms, legacy_ring }
    }

    /// Consume an encoded key and zeroize it after decoding, including errors.
    pub fn from_owned_base64_key(encoded: String) -> Result<Self, CipherError> {
        Self::from_base64_key(&Zeroizing::new(encoded))
    }

    /// Build the cipher from a base64 (standard alphabet) encoding of exactly 32 key bytes.
    pub fn from_base64_key(encoded: &str) -> Result<Self, CipherError> {
        let ring = LocalKeyringProvider::from_single_base64(KekId::legacy_default(), encoded)
            .map_err(|_| CipherError::MasterKey)?;
        Ok(Self::from_local_keyring(ring))
    }

    /// Build the cipher directly from raw key bytes (must be exactly 32).
    pub fn from_key_bytes(bytes: &[u8]) -> Result<Self, CipherError> {
        let key: Zeroizing<[u8; KEY_LEN]> =
            Zeroizing::new(bytes.try_into().map_err(|_| CipherError::MasterKey)?);
        let ring = LocalKeyringProvider::from_single_key(
            KekId::legacy_default(),
            SecretBox::new(Box::new(*key)),
        );
        Ok(Self::from_local_keyring(ring))
    }

    /// Decrypt and return plaintext bytes for callers outside comms (RRN vault).
    pub fn open_bytes(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<Vec<u8>, CipherError> {
        Ok(self.decrypt(sealed, aad)?.expose_secret().clone())
    }

    /// Decrypt and pass plaintext bytes to `f` without copying out of [`SecretBox`].
    pub fn open_with<T>(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
        f: impl FnOnce(&[u8]) -> T,
    ) -> Result<T, CipherError> {
        let plain = self.decrypt(sealed, aad)?;
        Ok(f(plain.expose_secret()))
    }
}

impl CredentialCipher for EnvelopeCredentialCipher {
    fn encrypt(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError> {
        self.encrypt_with_suite(CURRENT_KEY_VERSION, plaintext, aad)
    }

    fn decrypt(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SecretBox<Vec<u8>>, CipherError> {
        if self.kms.is_shredded() {
            return Err(CipherError::Decrypt);
        }
        match sealed.key_version {
            1 => {
                let ring = self.legacy_ring.as_deref().ok_or(CipherError::KeyVersion)?;
                legacy::decrypt_v1(ring, sealed, aad)
            }
            2 => {
                let ring = self.legacy_ring.as_deref().ok_or(CipherError::KeyVersion)?;
                legacy::decrypt_v2(ring, sealed, aad)
            }
            3 => self.decrypt_v3(sealed, aad),
            _ => Err(CipherError::KeyVersion),
        }
    }

    fn active_alg_id(&self) -> Option<&str> {
        Some(EnvelopeCredentialCipher::active_alg_id(self).as_str())
    }

    fn active_kek_id(&self) -> Option<&str> {
        Some(EnvelopeCredentialCipher::active_kek_id(self).as_str())
    }

    fn reseal(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SealedCredential, CipherError> {
        EnvelopeCredentialCipher::reseal(self, sealed, aad)
    }
}

impl EnvelopeCredentialCipher {
    /// Seal with an explicit envelope suite (`1`, `2`, or `3`) for compatibility proofs.
    pub fn encrypt_with_suite(
        &self,
        suite: i16,
        plaintext: &[u8],
        aad: Aad<'_>,
    ) -> Result<SealedCredential, CipherError> {
        if self.kms.is_shredded() {
            return Err(CipherError::Encrypt);
        }
        match suite {
            1 => {
                let ring = self.legacy_ring.as_deref().ok_or(CipherError::MasterKey)?;
                legacy::encrypt_v1(ring, plaintext, aad)
            }
            2 => {
                let ring = self.legacy_ring.as_deref().ok_or(CipherError::MasterKey)?;
                legacy::encrypt_v2(ring, plaintext, aad)
            }
            3 => self.encrypt_v3(plaintext, aad),
            _ => Err(CipherError::KeyVersion),
        }
    }

    fn encrypt_v3(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError> {
        let sealed = seal_v3(self.kms.as_ref(), envelope_context(aad), plaintext)
            .map_err(|_| CipherError::Encrypt)?;
        Ok(SealedCredential {
            ciphertext: sealed.ciphertext,
            nonce: sealed.header.nonce.to_vec(),
            dek_wrapped: sealed.header.wrapped_dek,
            dek_nonce: Vec::new(),
            key_version: 3,
            alg_id: Some(sealed.header.alg_id.as_str().to_owned()),
            kek_id: Some(sealed.header.kek_id.as_str().to_owned()),
            msg_id: Some(sealed.header.msg_id.to_vec()),
            commitment_tag: Some(sealed.header.commitment_tag.to_vec()),
        })
    }

    fn decrypt_v3(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SecretBox<Vec<u8>>, CipherError> {
        if !sealed.dek_nonce.is_empty() {
            return Err(CipherError::Decrypt);
        }
        let alg_str = sealed.alg_id.as_deref().ok_or(CipherError::Decrypt)?;
        let alg_id = AlgId::parse_str(alg_str).map_err(|_| CipherError::KeyVersion)?;
        if alg_id.is_pq_reserved() {
            return Err(CipherError::KeyVersion);
        }
        if alg_id != AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap {
            return Err(CipherError::Decrypt);
        }
        let kek_raw = sealed.kek_id.as_deref().ok_or(CipherError::Decrypt)?;
        let kek_id = KekId::new(kek_raw).map_err(|_| CipherError::Decrypt)?;
        let msg_id: [u8; 32] = sealed
            .msg_id
            .as_deref()
            .ok_or(CipherError::Decrypt)?
            .try_into()
            .map_err(|_| CipherError::Decrypt)?;
        let commitment_tag: [u8; 32] = sealed
            .commitment_tag
            .as_deref()
            .ok_or(CipherError::Decrypt)?
            .try_into()
            .map_err(|_| CipherError::Decrypt)?;
        let nonce: [u8; 12] = sealed
            .nonce
            .as_slice()
            .try_into()
            .map_err(|_| CipherError::Decrypt)?;

        let envelope = SealedEnvelope {
            header: EnvelopeHeader {
                wire_version: 1,
                alg_id,
                kek_id,
                msg_id,
                commitment_tag,
                nonce,
                wrapped_dek: sealed.dek_wrapped.clone(),
            },
            ciphertext: sealed.ciphertext.clone(),
        };
        open_v3(self.kms.as_ref(), envelope_context(aad), &envelope).map_err(|err| match err {
            CryptoError::UnsupportedAlgorithm => CipherError::KeyVersion,
            _ => CipherError::Decrypt,
        })
    }
}

fn envelope_context(aad: Aad<'_>) -> EnvelopeContext<'_> {
    if aad.account_id == "employee_rrn" && aad.field == "rrn" {
        EnvelopeContext {
            tenant_id: aad.org_id,
            table: "employee_rrn",
            record: "employee_rrn",
            field: "rrn",
            purpose: "rrn_vault",
        }
    } else {
        EnvelopeContext {
            tenant_id: aad.org_id,
            table: "email_accounts",
            record: aad.account_id,
            field: aad.field,
            purpose: "credential",
        }
    }
}

#[cfg(test)]
#[path = "legacy_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "version_tests.rs"]
mod version_tests;
