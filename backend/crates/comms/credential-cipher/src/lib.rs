//! Webmail credential cipher — envelope AEAD for SMTP/IMAP passwords at rest.
//!
//! This crate provides the CONCRETE [`EnvelopeCredentialCipher`] implementation
//! of the [`CredentialCipher`] PORT. The trait and its value types ([`Aad`],
//! [`SealedCredential`], [`CipherError`]) are owned by the application layer
//! (`console-comms-application`); this crate depends on that abstraction and
//! implements it, so the dependency direction stays clean (the application /
//! adapter layers speak only to the port, and only the app composition root
//! wires this concrete cipher).
//!
//! # Versioned envelope encryption
//!
//! Version 1 reads and writes XChaCha20-Poly1305 envelopes during rollout.
//! Version 2 supports AES-256-GCM
//! with a fresh random 256-bit DEK and 96-bit nonce per secret, and AES-256-KWP
//! (RFC 5649 / NIST SP 800-38F) to wrap the DEK under the existing master KEK.
//! The existing `key_version` identifies the complete envelope suite: 1 or 2.
//! V2's `dek_nonce` is empty because KWP needs no nonce. AAD binds the GCM
//! payload to tenant/row/purpose; replacing a wrapped DEK fails payload auth.
//!
//! Each GCM key encrypts exactly once, below SP 800-38D §8.3's 2^32 limit.
//! KWP avoids random GCM nonces and invocation budgets on the shared KEK.
//! See `docs/architecture/credential-encryption.md` for rotation and format.
//!
//! Keys remain Vault/env-injected; secret buffers are zeroized on drop. This
//! crate logs nothing and returns only coarse, secret-free errors.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
// Keep chacha20poly1305 0.10.1: the upstream 0.11 bump broke this cipher.
use aws_lc_rs::{
    aead,
    key_wrap::{AES_256, AesKek, KeyWrapPadded},
    rand::{SecureRandom, SystemRandom},
};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use secrecy::{ExposeSecret, SecretBox};
use zeroize::Zeroizing;

pub use console_comms_application::credential_cipher::{
    Aad, CipherError, CredentialCipher, SealedCredential,
};

/// The environment variable carrying the base64-encoded 32-byte master KEK.
pub const MASTER_KEY_ENV: &str = "CONSOLE_MAIL_MASTER_KEY";

/// Keep v1 writes until the dual-reader release is deployed for safe rollback.
pub const CURRENT_KEY_VERSION: i16 = 1;

const KEY_LEN: usize = 32;

/// Versioned envelope cipher holding the master KEK in a [`SecretBox`].
pub struct EnvelopeCredentialCipher {
    /// The master key-encryption key (32 bytes), zeroized on drop.
    kek: SecretBox<[u8; KEY_LEN]>,
}

impl EnvelopeCredentialCipher {
    /// Build the cipher from the base64-encoded 32-byte KEK in the
    /// `CONSOLE_MAIL_MASTER_KEY` environment variable.
    pub fn from_env() -> Result<Self, CipherError> {
        let encoded = std::env::var(MASTER_KEY_ENV).map_err(|_| CipherError::MasterKey)?;
        Self::from_owned_base64_key(encoded)
    }

    /// Consume an encoded key and zeroize it after decoding, including errors.
    pub fn from_owned_base64_key(encoded: String) -> Result<Self, CipherError> {
        Self::from_base64_key(&Zeroizing::new(encoded))
    }

    /// Build the cipher from a base64 (standard alphabet) encoding of exactly
    /// 32 key bytes. The decoded buffer is zeroized after the key is copied in.
    pub fn from_base64_key(encoded: &str) -> Result<Self, CipherError> {
        let mut decoded = Zeroizing::new(Vec::new());
        BASE64
            .decode_vec(encoded.trim(), &mut decoded)
            .map_err(|_| CipherError::MasterKey)?;
        Self::from_key_bytes(&decoded)
    }

    /// Build the cipher directly from raw key bytes (must be exactly 32).
    pub fn from_key_bytes(bytes: &[u8]) -> Result<Self, CipherError> {
        let key: Zeroizing<[u8; KEY_LEN]> =
            Zeroizing::new(bytes.try_into().map_err(|_| CipherError::MasterKey)?);
        Ok(Self {
            kek: SecretBox::new(Box::new(*key)),
        })
    }

    /// [`CredentialCipher::decrypt`] for a caller outside the comms context
    /// (IMPORT-2's 주민등록번호 vault, under its own master key): the plain
    /// bytes, which the caller turns into its own value at once and drops.
    ///
    /// # Errors
    /// [`CipherError::Decrypt`] / [`CipherError::KeyVersion`] as `decrypt`.
    pub fn open_bytes(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<Vec<u8>, CipherError> {
        Ok(self.decrypt(sealed, aad)?.expose_secret().clone())
    }

    /// The KEK cipher instance. Constructed per call so the expanded key
    /// schedule never outlives the operation.
    fn kek_cipher(&self) -> XChaCha20Poly1305 {
        let key = Key::from_slice(self.kek.expose_secret().as_slice());
        XChaCha20Poly1305::new(key)
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
        match sealed.key_version {
            1 => self.decrypt_v1(sealed, aad),
            2 => self.decrypt_v2(sealed, aad),
            _ => Err(CipherError::KeyVersion),
        }
    }
}

impl EnvelopeCredentialCipher {
    /// Seal with an explicit envelope suite for compatibility proofs and re-sealing.
    /// Runtime writers must use [`CredentialCipher::encrypt`] during rollout.
    ///
    /// # Errors
    /// Unknown suites return [`CipherError::KeyVersion`]; sealing can return
    /// [`CipherError::Encrypt`].
    pub fn encrypt_with_suite(
        &self,
        suite: i16,
        plaintext: &[u8],
        aad: Aad<'_>,
    ) -> Result<SealedCredential, CipherError> {
        match suite {
            1 => self.encrypt_v1(plaintext, aad),
            2 => self.encrypt_v2(plaintext, aad),
            _ => Err(CipherError::KeyVersion),
        }
    }

    fn encrypt_v1(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError> {
        let rng = SystemRandom::new();
        let mut dek = Zeroizing::new([0u8; KEY_LEN]);
        rng.fill(dek.as_mut()).map_err(|_| CipherError::Encrypt)?;
        let nonce: [u8; 24] = random(&rng)?;
        let dek_nonce: [u8; 24] = random(&rng)?;
        let aad_bytes = aad.encode();
        let ciphertext = XChaCha20Poly1305::new(Key::from_slice(dek.as_ref()))
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad_bytes,
                },
            )
            .map_err(|_| CipherError::Encrypt)?;
        let dek_wrapped = self
            .kek_cipher()
            .encrypt(
                XNonce::from_slice(&dek_nonce),
                Payload {
                    msg: dek.as_ref(),
                    aad: &aad_bytes,
                },
            )
            .map_err(|_| CipherError::Encrypt)?;
        Ok(SealedCredential {
            ciphertext,
            nonce: nonce.to_vec(),
            dek_wrapped,
            dek_nonce: dek_nonce.to_vec(),
            key_version: 1,
        })
    }

    fn encrypt_v2(&self, plaintext: &[u8], aad: Aad<'_>) -> Result<SealedCredential, CipherError> {
        let rng = SystemRandom::new();
        let mut dek = Zeroizing::new([0u8; KEY_LEN]);
        rng.fill(dek.as_mut()).map_err(|_| CipherError::Encrypt)?;
        let nonce: [u8; aead::NONCE_LEN] = random(&rng)?;
        let ciphertext = gcm_seal(dek.as_ref(), nonce, plaintext, &aad.encode())?;
        let kek =
            AesKek::new(&AES_256, self.kek.expose_secret()).map_err(|_| CipherError::Encrypt)?;
        let mut wrapped = [0u8; KEY_LEN + 8];
        let dek_wrapped = kek
            .wrap_with_padding(dek.as_ref(), &mut wrapped)
            .map_err(|_| CipherError::Encrypt)?
            .to_vec();
        Ok(SealedCredential {
            ciphertext,
            nonce: nonce.to_vec(),
            dek_wrapped,
            dek_nonce: Vec::new(),
            key_version: 2,
        })
    }

    fn decrypt_v2(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SecretBox<Vec<u8>>, CipherError> {
        if !sealed.dek_nonce.is_empty() {
            return Err(CipherError::Decrypt);
        }
        let nonce: [u8; aead::NONCE_LEN] = sealed
            .nonce
            .as_slice()
            .try_into()
            .map_err(|_| CipherError::Decrypt)?;
        let kek =
            AesKek::new(&AES_256, self.kek.expose_secret()).map_err(|_| CipherError::Decrypt)?;
        let mut dek = Zeroizing::new([0u8; KEY_LEN + 8]);
        let key = kek
            .unwrap_with_padding(&sealed.dek_wrapped, dek.as_mut())
            .map_err(|_| CipherError::Decrypt)?;
        let key =
            aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| CipherError::Decrypt)?;
        let mut plaintext = Zeroizing::new(sealed.ciphertext.clone());
        let len = aead::LessSafeKey::new(key)
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(aad.encode()),
                &mut plaintext,
            )
            .map_err(|_| CipherError::Decrypt)?
            .len();
        plaintext.truncate(len);
        Ok(SecretBox::new(Box::new(std::mem::take(&mut *plaintext))))
    }

    fn decrypt_v1(
        &self,
        sealed: &SealedCredential,
        aad: Aad<'_>,
    ) -> Result<SecretBox<Vec<u8>>, CipherError> {
        let aad_bytes = aad.encode();

        // 1. Unwrap the DEK under the KEK (authenticates the wrap + AAD).
        let kek_cipher = self.kek_cipher();
        let dek_nonce = nonce_from_slice(&sealed.dek_nonce)?;
        let dek_bytes = Zeroizing::new(
            kek_cipher
                .decrypt(
                    &dek_nonce,
                    Payload {
                        msg: &sealed.dek_wrapped,
                        aad: &aad_bytes,
                    },
                )
                .map_err(|_| CipherError::Decrypt)?,
        );
        if dek_bytes.len() != KEY_LEN {
            return Err(CipherError::Decrypt);
        }

        // 2. Decrypt the secret under the DEK (authenticates the secret + AAD).
        let dek_cipher = XChaCha20Poly1305::new(Key::from_slice(&dek_bytes));
        let nonce = nonce_from_slice(&sealed.nonce)?;
        let plaintext = dek_cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &sealed.ciphertext,
                    aad: &aad_bytes,
                },
            )
            .map_err(|_| CipherError::Decrypt)?;

        Ok(SecretBox::new(Box::new(plaintext)))
    }
}

fn random<const N: usize>(rng: &SystemRandom) -> Result<[u8; N], CipherError> {
    aws_lc_rs::rand::generate(rng)
        .map(|r| r.expose())
        .map_err(|_| CipherError::Encrypt)
}

fn gcm_seal(
    key: &[u8],
    nonce: [u8; aead::NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CipherError> {
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| CipherError::Encrypt)?;
    let mut ciphertext = Zeroizing::new(plaintext.to_vec());
    aead::LessSafeKey::new(key)
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad),
            &mut *ciphertext,
        )
        .map_err(|_| CipherError::Encrypt)?;
    Ok(std::mem::take(&mut *ciphertext))
}

/// Build a 24-byte XChaCha nonce from a stored slice, rejecting the wrong size.
fn nonce_from_slice(bytes: &[u8]) -> Result<XNonce, CipherError> {
    if bytes.len() != 24 {
        return Err(CipherError::Decrypt);
    }
    Ok(*XNonce::from_slice(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic 32-byte test KEK, base64-encoded.
    fn test_key_b64() -> String {
        let key = [7u8; KEY_LEN];
        BASE64.encode(key)
    }

    fn cipher() -> EnvelopeCredentialCipher {
        EnvelopeCredentialCipher::from_owned_base64_key(test_key_b64()).unwrap()
    }

    fn aad<'a>() -> Aad<'a> {
        Aad {
            org_id: "11111111-1111-1111-1111-111111111111",
            account_id: "22222222-2222-2222-2222-222222222222",
            field: "smtp_password",
        }
    }

    #[test]
    fn round_trip_recovers_plaintext() {
        let c = cipher();
        let secret = b"super-secret-smtp-pw";
        let sealed = c.encrypt(secret, aad()).unwrap();
        let out = c.decrypt(&sealed, aad()).unwrap();
        assert_eq!(out.expose_secret().as_slice(), secret);
    }

    #[test]
    fn ciphertext_is_not_plaintext_and_v2_has_gcm_nonce() {
        let c = cipher();
        let secret = b"another-pw";
        let sealed = c.encrypt_with_suite(2, secret, aad()).unwrap();
        assert_ne!(sealed.ciphertext, secret);
        assert_eq!(sealed.nonce.len(), 12);
        assert!(sealed.dek_nonce.is_empty());
        assert_eq!(sealed.key_version, 2);
        // KWP adds its 8-byte integrity/length block to a 32-byte DEK.
        assert_eq!(sealed.dek_wrapped.len(), KEY_LEN + 8);
    }

    #[test]
    fn fresh_dek_and_nonce_per_call_yield_distinct_ciphertext() {
        let c = cipher();
        let secret = b"same-input";
        let a = c.encrypt(secret, aad()).unwrap();
        let b = c.encrypt(secret, aad()).unwrap();
        // Random DEK + random nonces => different ciphertext for identical input.
        assert_ne!(a.ciphertext, b.ciphertext);
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.dek_wrapped, b.dek_wrapped);
        // Both still decrypt to the same plaintext.
        assert_eq!(
            c.decrypt(&a, aad()).unwrap().expose_secret().as_slice(),
            secret
        );
        assert_eq!(
            c.decrypt(&b, aad()).unwrap().expose_secret().as_slice(),
            secret
        );
    }

    #[test]
    fn wrong_kek_fails_to_decrypt() {
        let c = cipher();
        let sealed = c.encrypt(b"pw", aad()).unwrap();
        let other = EnvelopeCredentialCipher::from_key_bytes(&[9u8; KEY_LEN]).unwrap();
        assert!(matches!(
            other.decrypt(&sealed, aad()),
            Err(CipherError::Decrypt)
        ));
    }

    #[test]
    fn tampered_ciphertext_fails_auth() {
        let c = cipher();
        let mut sealed = c.encrypt(b"pw", aad()).unwrap();
        sealed.ciphertext[0] ^= 0xff;
        assert!(matches!(
            c.decrypt(&sealed, aad()),
            Err(CipherError::Decrypt)
        ));
    }

    #[test]
    fn tampered_nonce_fails_auth() {
        let c = cipher();
        let mut sealed = c.encrypt(b"pw", aad()).unwrap();
        sealed.nonce[0] ^= 0xff;
        assert!(matches!(
            c.decrypt(&sealed, aad()),
            Err(CipherError::Decrypt)
        ));
    }

    #[test]
    fn tampered_wrapped_dek_fails_auth() {
        let c = cipher();
        let mut sealed = c.encrypt(b"pw", aad()).unwrap();
        sealed.dek_wrapped[0] ^= 0xff;
        assert!(matches!(
            c.decrypt(&sealed, aad()),
            Err(CipherError::Decrypt)
        ));
    }

    #[test]
    fn tampered_dek_nonce_fails_auth() {
        let c = cipher();
        let mut sealed = c.encrypt(b"pw", aad()).unwrap();
        sealed.dek_nonce.push(0xff);
        assert!(matches!(
            c.decrypt(&sealed, aad()),
            Err(CipherError::Decrypt)
        ));
    }

    #[test]
    fn wrong_aad_org_fails_auth() {
        let c = cipher();
        let sealed = c.encrypt(b"pw", aad()).unwrap();
        let mut bad = aad();
        bad.org_id = "99999999-9999-9999-9999-999999999999";
        assert!(matches!(c.decrypt(&sealed, bad), Err(CipherError::Decrypt)));
    }

    #[test]
    fn wrong_aad_account_fails_auth() {
        let c = cipher();
        let sealed = c.encrypt(b"pw", aad()).unwrap();
        let mut bad = aad();
        bad.account_id = "00000000-0000-0000-0000-000000000000";
        assert!(matches!(c.decrypt(&sealed, bad), Err(CipherError::Decrypt)));
    }

    #[test]
    fn wrong_aad_field_fails_auth() {
        // The crux of envelope AAD-binding: a ciphertext sealed for
        // `smtp_password` must NOT decrypt under the `imap_password` field.
        let c = cipher();
        let sealed = c.encrypt(b"pw", aad()).unwrap();
        let mut bad = aad();
        bad.field = "imap_password";
        assert!(matches!(c.decrypt(&sealed, bad), Err(CipherError::Decrypt)));
    }

    #[test]
    fn aad_encoding_is_unambiguous() {
        // Length-prefixing keeps ("ab","c") distinct from ("a","bc").
        let one = Aad {
            org_id: "ab",
            account_id: "c",
            field: "f",
        }
        .encode();
        let two = Aad {
            org_id: "a",
            account_id: "bc",
            field: "f",
        }
        .encode();
        assert_ne!(one, two);
    }

    #[test]
    fn wrong_key_version_is_rejected() {
        let c = cipher();
        let mut sealed = c.encrypt(b"pw", aad()).unwrap();
        sealed.key_version = 99;
        assert!(matches!(
            c.decrypt(&sealed, aad()),
            Err(CipherError::KeyVersion)
        ));
    }

    #[test]
    fn bad_master_key_inputs_are_rejected() {
        assert!(matches!(
            EnvelopeCredentialCipher::from_base64_key("not!base64!"),
            Err(CipherError::MasterKey)
        ));
        // Valid base64 but wrong length (16 bytes, not 32).
        let short = BASE64.encode([1u8; 16]);
        assert!(matches!(
            EnvelopeCredentialCipher::from_base64_key(&short),
            Err(CipherError::MasterKey)
        ));
        assert!(matches!(
            EnvelopeCredentialCipher::from_key_bytes(&[0u8; 31]),
            Err(CipherError::MasterKey)
        ));
    }

    #[test]
    fn secret_debug_is_redacted() {
        // `SecretBox`'s Debug never prints the secret bytes.
        let c = cipher();
        let sealed = c.encrypt(b"top-secret-value", aad()).unwrap();
        let recovered = c.decrypt(&sealed, aad()).unwrap();
        let dbg = format!("{recovered:?}");
        assert!(
            dbg.contains("REDACTED"),
            "secret Debug must redact, got: {dbg}"
        );
        assert!(!dbg.contains("top-secret-value"));
    }

    #[test]
    fn empty_plaintext_round_trips() {
        let c = cipher();
        let sealed = c.encrypt(b"", aad()).unwrap();
        let out = c.decrypt(&sealed, aad()).unwrap();
        assert!(out.expose_secret().is_empty());
    }

    #[test]
    fn wrong_nonce_length_is_rejected() {
        let c = cipher();
        let mut sealed = c.encrypt(b"pw", aad()).unwrap();
        sealed.nonce.truncate(11);
        assert!(matches!(
            c.decrypt(&sealed, aad()),
            Err(CipherError::Decrypt)
        ));
    }
}

#[cfg(test)]
#[path = "version_tests.rs"]
mod version_tests;
