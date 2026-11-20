// SPDX-License-Identifier: LicenseRef-Proprietary
//! Coarse, secret-free cryptographic errors.

use thiserror::Error;

/// Opaque error type returned by envelope, keyring, and KMS operations.
///
/// Errors deliberately omit key material, plaintext bytes, and sub-check
/// distinctions during decryption to prevent padding/commitment/tag oracles.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CryptoError {
    /// Caller-supplied metadata or envelope structural parameter is invalid.
    #[error("invalid cryptographic input")]
    InvalidInput,
    /// Key material or keyring configuration is missing, malformed, or wrong length.
    #[error("invalid key material or keyring configuration")]
    InvalidKeyMaterial,
    /// Requested KEK identifier is not present in the provider/ring.
    #[error("key identifier not found")]
    KeyNotFound,
    /// Algorithm suite identifier is unknown, legacy-only for seal, or PQ-reserved.
    #[error("unsupported cryptographic algorithm suite")]
    UnsupportedAlgorithm,
    /// Remote KMS/HSM provider is unconfigured or unavailable (fail-closed).
    #[error("kms provider unavailable")]
    ProviderUnavailable,
    /// Envelope encryption or key wrapping failed.
    #[error("envelope encryption failed")]
    Encrypt,
    /// Envelope authentication, commitment verification, or decryption failed.
    #[error("envelope decryption failed")]
    Decrypt,
}
