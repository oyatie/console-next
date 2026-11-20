// SPDX-License-Identifier: LicenseRef-Proprietary
//! Webmail credential cipher port and envelope value types.

use secrecy::ExposeSecret;
pub use secrecy::SecretBox;

/// Errors from the credential cipher. Deliberately coarse and free of any
/// secret material — an attacker learns only "it failed", never plaintext,
/// key bytes, or which check failed in a way that aids forgery.
#[derive(Debug, thiserror::Error)]
pub enum CipherError {
    /// The master KEK / keyring configuration is missing, malformed, or not 32 bytes.
    #[error("master key configuration error")]
    MasterKey,
    /// AEAD encryption failed (allocation/internal). Carries no detail.
    #[error("encryption failed")]
    Encrypt,
    /// AEAD decryption/authentication failed: wrong KEK, tampered ciphertext /
    /// nonce / wrapped DEK / commitment tag, or mismatched AAD (wrong org/account/field).
    #[error("decryption failed")]
    Decrypt,
    /// A persisted key_version / algorithm suite this build cannot interpret.
    #[error("unsupported key version")]
    KeyVersion,
}

/// Associated data binding a ciphertext to the exact row + field it belongs to.
#[derive(Debug, Clone, Copy)]
pub struct Aad<'a> {
    /// The owning tenant (`email_accounts.org_id`).
    pub org_id: &'a str,
    /// The owning account row (`email_accounts.id`).
    pub account_id: &'a str,
    /// The credential field, e.g. `"smtp_password"` / `"imap_password"`.
    pub field: &'a str,
}

impl Aad<'_> {
    /// Length-prefixed, unambiguous byte encoding of the triple.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for part in [self.org_id, self.account_id, self.field] {
            let bytes = part.as_bytes();
            out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            out.extend_from_slice(bytes);
        }
        out
    }
}

/// The persisted output of [`CredentialCipher::encrypt`]. Every field is
/// opaque ciphertext / nonce / metadata safe to store; NONE of it reveals the
/// plaintext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedCredential {
    /// AEAD ciphertext of the secret, including its authentication tag.
    pub ciphertext: Vec<u8>,
    /// Payload nonce: 24 bytes for v1 XChaCha, 12 bytes for v2/v3 AES-GCM.
    pub nonce: Vec<u8>,
    /// The DEK, wrapped under the KEK with integrity protection.
    pub dek_wrapped: Vec<u8>,
    /// 24-byte wrap nonce for v1; empty for nonce-free v2/v3 AES-KWP.
    pub dek_nonce: Vec<u8>,
    /// Envelope suite: 1 = XChaCha20-Poly1305, 2 = legacy AES-GCM+KWP, 3 = AWS-ESDK-v2.
    pub key_version: i16,
    /// Explicit algorithm suite identifier for crypto-agile dual-read (`None` on legacy v1/v2).
    pub alg_id: Option<String>,
    /// Wrapping KEK identifier (`None` on legacy v1/v2 single-key rows).
    pub kek_id: Option<String>,
    /// 32-byte per-message HKDF salt for v3 AWS-ESDK-v2 (`None` on v1/v2).
    pub msg_id: Option<Vec<u8>>,
    /// 32-byte key-commitment tag for v3 AWS-ESDK-v2 (`None` on v1/v2).
    pub commitment_tag: Option<Vec<u8>>,
}

/// Envelope credential cipher port.
pub trait CredentialCipher: Send + Sync {
    /// Seal `plaintext` under a fresh per-row DEK wrapped by the master KEK,
    /// binding `aad` (org/account/field) as associated data.
    fn encrypt(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError>;

    /// Recover the plaintext secret from a [`SealedCredential`].
    fn decrypt(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SecretBox<Vec<u8>>, CipherError>;

    /// Canonical `alg_id` written by [`CredentialCipher::encrypt`], if crypto-agile (`v3+`).
    fn active_alg_id(&self) -> Option<&str> {
        None
    }

    /// Active wrapping KEK identifier written by [`CredentialCipher::encrypt`], if any.
    fn active_kek_id(&self) -> Option<&str> {
        None
    }

    /// Re-seal `sealed` under the active writer suite and KEK.
    fn reseal(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SealedCredential, CipherError> {
        let plain = self.decrypt(sealed, aad)?;
        self.encrypt(plain.expose_secret(), aad)
    }

    /// Resolve a tenant-scoped cipher for `org` at an async boundary, or
    /// `Ok(None)` when the cipher has no per-tenant key store.
    fn scoped_for_org<'a>(&'a self, _org: uuid::Uuid) -> ScopedCredentialCipherFuture<'a> {
        Box::pin(async { Ok(None) })
    }
}

/// Boxed future returned by [`CredentialCipher::scoped_for_org`].
pub type ScopedCredentialCipherFuture<'a> = std::pin::Pin<
    Box<
        dyn core::future::Future<
                Output = Result<Option<std::sync::Arc<dyn CredentialCipher>>, CipherError>,
            > + Send
            + 'a,
    >,
>;

impl<C: CredentialCipher + ?Sized> CredentialCipher for &C {
    fn encrypt(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError> {
        (**self).encrypt(plaintext, aad)
    }

    fn decrypt(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SecretBox<Vec<u8>>, CipherError> {
        (**self).decrypt(sealed, aad)
    }

    fn active_alg_id(&self) -> Option<&str> {
        (**self).active_alg_id()
    }

    fn active_kek_id(&self) -> Option<&str> {
        (**self).active_kek_id()
    }

    fn reseal(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SealedCredential, CipherError> {
        (**self).reseal(sealed, aad)
    }

    fn scoped_for_org<'a>(&'a self, org: uuid::Uuid) -> ScopedCredentialCipherFuture<'a> {
        (**self).scoped_for_org(org)
    }
}

impl<C: CredentialCipher + ?Sized> CredentialCipher for std::sync::Arc<C> {
    fn encrypt(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError> {
        (**self).encrypt(plaintext, aad)
    }

    fn decrypt(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SecretBox<Vec<u8>>, CipherError> {
        (**self).decrypt(sealed, aad)
    }

    fn active_alg_id(&self) -> Option<&str> {
        (**self).active_alg_id()
    }

    fn active_kek_id(&self) -> Option<&str> {
        (**self).active_kek_id()
    }

    fn reseal(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SealedCredential, CipherError> {
        (**self).reseal(sealed, aad)
    }

    fn scoped_for_org<'a>(&'a self, org: uuid::Uuid) -> ScopedCredentialCipherFuture<'a> {
        (**self).scoped_for_org(org)
    }
}
