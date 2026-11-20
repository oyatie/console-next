// SPDX-License-Identifier: LicenseRef-Proprietary
//! Pluggable synchronous and asynchronous KMS provider ports.

use core::future::Future;
use core::pin::Pin;
use std::sync::Arc;

use secrecy::SecretBox;

use crate::error::CryptoError;
use crate::header::KekId;

/// Boxed future alias avoiding extra proc-macro crate dependencies.
pub type KmsFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Result of wrapping a 256-bit DEK under the provider's active KEK.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedDek {
    pub kek_id: KekId,
    pub ciphertext: Vec<u8>,
}

/// Synchronous KMS / KEK provider port for in-process keyrings and sync ciphers.
pub trait KmsProvider: Send + Sync {
    /// Identifier of the KEK currently used for new wraps.
    fn active_kek_id(&self) -> &KekId;

    /// Wrap a fresh 256-bit DEK under the active KEK, bound to `purpose`.
    fn wrap_dek(&self, purpose: &str, dek: &SecretBox<[u8; 32]>)
    -> Result<WrappedDek, CryptoError>;

    /// Unwrap a wrapped DEK strictly under `kek_id` (no cross-key fallback), bound to `purpose`.
    fn unwrap_dek(
        &self,
        kek_id: &KekId,
        purpose: &str,
        wrapped_dek: &[u8],
    ) -> Result<SecretBox<[u8; 32]>, CryptoError>;

    /// Whether this provider represents a cryptographically shredded tenant scope
    /// that must fail closed across all envelope versions.
    fn is_shredded(&self) -> bool {
        false
    }
}

/// Asynchronous KMS provider port for future remote HSM/Vault adapters.
pub trait AsyncKmsProvider: Send + Sync {
    /// Identifier of the KEK currently used for new wraps.
    fn active_kek_id(&self) -> &KekId;

    /// Wrap a fresh 256-bit DEK under the active KEK, bound to `purpose`.
    fn wrap_dek<'a>(
        &'a self,
        purpose: &'a str,
        dek: &'a SecretBox<[u8; 32]>,
    ) -> KmsFuture<'a, Result<WrappedDek, CryptoError>>;

    /// Unwrap a wrapped DEK strictly under `kek_id`, bound to `purpose`.
    fn unwrap_dek<'a>(
        &'a self,
        kek_id: &'a KekId,
        purpose: &'a str,
        wrapped_dek: &'a [u8],
    ) -> KmsFuture<'a, Result<SecretBox<[u8; 32]>, CryptoError>>;
}

impl<T: KmsProvider + ?Sized> KmsProvider for Arc<T> {
    fn active_kek_id(&self) -> &KekId {
        (**self).active_kek_id()
    }

    fn wrap_dek(
        &self,
        purpose: &str,
        dek: &SecretBox<[u8; 32]>,
    ) -> Result<WrappedDek, CryptoError> {
        (**self).wrap_dek(purpose, dek)
    }

    fn unwrap_dek(
        &self,
        kek_id: &KekId,
        purpose: &str,
        wrapped_dek: &[u8],
    ) -> Result<SecretBox<[u8; 32]>, CryptoError> {
        (**self).unwrap_dek(kek_id, purpose, wrapped_dek)
    }

    fn is_shredded(&self) -> bool {
        (**self).is_shredded()
    }
}

impl<T: KmsProvider + ?Sized> AsyncKmsProvider for T {
    fn active_kek_id(&self) -> &KekId {
        KmsProvider::active_kek_id(self)
    }

    fn wrap_dek<'a>(
        &'a self,
        purpose: &'a str,
        dek: &'a SecretBox<[u8; 32]>,
    ) -> KmsFuture<'a, Result<WrappedDek, CryptoError>> {
        let res = KmsProvider::wrap_dek(self, purpose, dek);
        Box::pin(async move { res })
    }

    fn unwrap_dek<'a>(
        &'a self,
        kek_id: &'a KekId,
        purpose: &'a str,
        wrapped_dek: &'a [u8],
    ) -> KmsFuture<'a, Result<SecretBox<[u8; 32]>, CryptoError>> {
        let res = KmsProvider::unwrap_dek(self, kek_id, purpose, wrapped_dek);
        Box::pin(async move { res })
    }
}
