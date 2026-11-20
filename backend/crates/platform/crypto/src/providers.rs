// SPDX-License-Identifier: LicenseRef-Proprietary
//! Fail-closed remote KMS / HSM provider configurations and HTTPS-only stubs.

use core::fmt;

use secrecy::SecretString;
use zeroize::ZeroizeOnDrop;

use crate::error::CryptoError;
use crate::header::KekId;
use crate::kms::{AsyncKmsProvider, KmsFuture, WrappedDek};

fn validate_https_endpoint(url: &str) -> Result<(), CryptoError> {
    let rest = url
        .strip_prefix("https://")
        .ok_or(CryptoError::InvalidInput)?;
    if rest.is_empty() || rest.chars().any(char::is_whitespace) {
        return Err(CryptoError::InvalidInput);
    }
    Ok(())
}

fn build_tls_client() -> Result<reqwest::Client, CryptoError> {
    reqwest::Client::builder()
        .https_only(true)
        .use_rustls_tls()
        .min_tls_version(reqwest::tls::Version::TLS_1_2)
        .build()
        .map_err(|_| CryptoError::ProviderUnavailable)
}

/// Configuration for OCI Vault KMS over HTTPS (`rustls`).
#[derive(Clone)]
pub struct OciVaultKmsConfig {
    pub endpoint_url: String,
    pub key_ocid: KekId,
    pub compartment_ocid: String,
    pub auth_token: SecretString,
}

impl ZeroizeOnDrop for OciVaultKmsConfig {}

impl fmt::Debug for OciVaultKmsConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OciVaultKmsConfig")
            .field("endpoint_url", &self.endpoint_url)
            .field("key_ocid", &self.key_ocid.as_str())
            .field("compartment_ocid", &self.compartment_ocid)
            .field("auth_token", &"[REDACTED]")
            .finish()
    }
}

/// Fail-closed OCI Vault KMS stub (`ProviderUnavailable` until wire activation).
pub struct OciVaultKmsProvider {
    config: OciVaultKmsConfig,
    _client: reqwest::Client,
}

impl fmt::Debug for OciVaultKmsProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OciVaultKmsProvider")
            .field("config", &self.config)
            .finish()
    }
}

impl OciVaultKmsProvider {
    /// Validate HTTPS endpoint and construct a `rustls` TLS 1.2+ client.
    pub fn new(config: OciVaultKmsConfig) -> Result<Self, CryptoError> {
        validate_https_endpoint(&config.endpoint_url)?;
        let client = build_tls_client()?;
        Ok(Self {
            config,
            _client: client,
        })
    }
}

impl AsyncKmsProvider for OciVaultKmsProvider {
    fn active_kek_id(&self) -> &KekId {
        &self.config.key_ocid
    }

    fn wrap_dek<'a>(
        &'a self,
        _purpose: &'a str,
        _dek: &'a secrecy::SecretBox<[u8; 32]>,
    ) -> KmsFuture<'a, Result<WrappedDek, CryptoError>> {
        Box::pin(async { Err(CryptoError::ProviderUnavailable) })
    }

    fn unwrap_dek<'a>(
        &'a self,
        _kek_id: &'a KekId,
        _purpose: &'a str,
        _wrapped_dek: &'a [u8],
    ) -> KmsFuture<'a, Result<secrecy::SecretBox<[u8; 32]>, CryptoError>> {
        Box::pin(async { Err(CryptoError::ProviderUnavailable) })
    }
}

/// Configuration for AWS KMS over HTTPS (`rustls`).
#[derive(Clone)]
pub struct AwsKmsConfig {
    pub region: String,
    pub key_id: KekId,
    pub endpoint_url: String,
    pub access_token: SecretString,
}

impl ZeroizeOnDrop for AwsKmsConfig {}

impl fmt::Debug for AwsKmsConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AwsKmsConfig")
            .field("region", &self.region)
            .field("key_id", &self.key_id.as_str())
            .field("endpoint_url", &self.endpoint_url)
            .field("access_token", &"[REDACTED]")
            .finish()
    }
}

/// Fail-closed AWS KMS stub (`ProviderUnavailable` until wire activation).
pub struct AwsKmsProvider {
    config: AwsKmsConfig,
    _client: reqwest::Client,
}

impl fmt::Debug for AwsKmsProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AwsKmsProvider")
            .field("config", &self.config)
            .finish()
    }
}

impl AwsKmsProvider {
    pub fn new(config: AwsKmsConfig) -> Result<Self, CryptoError> {
        validate_https_endpoint(&config.endpoint_url)?;
        let client = build_tls_client()?;
        Ok(Self {
            config,
            _client: client,
        })
    }
}

impl AsyncKmsProvider for AwsKmsProvider {
    fn active_kek_id(&self) -> &KekId {
        &self.config.key_id
    }

    fn wrap_dek<'a>(
        &'a self,
        _purpose: &'a str,
        _dek: &'a secrecy::SecretBox<[u8; 32]>,
    ) -> KmsFuture<'a, Result<WrappedDek, CryptoError>> {
        Box::pin(async { Err(CryptoError::ProviderUnavailable) })
    }

    fn unwrap_dek<'a>(
        &'a self,
        _kek_id: &'a KekId,
        _purpose: &'a str,
        _wrapped_dek: &'a [u8],
    ) -> KmsFuture<'a, Result<secrecy::SecretBox<[u8; 32]>, CryptoError>> {
        Box::pin(async { Err(CryptoError::ProviderUnavailable) })
    }
}

/// Configuration for KMIP/PKCS#11 HSM proxy over HTTPS (`rustls`).
#[derive(Clone)]
pub struct HsmKmsConfig {
    pub endpoint_url: String,
    pub key_id: KekId,
    pub client_id: String,
    pub client_secret: SecretString,
}

impl ZeroizeOnDrop for HsmKmsConfig {}

impl fmt::Debug for HsmKmsConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HsmKmsConfig")
            .field("endpoint_url", &self.endpoint_url)
            .field("key_id", &self.key_id.as_str())
            .field("client_id", &self.client_id)
            .field("client_secret", &"[REDACTED]")
            .finish()
    }
}

/// Fail-closed HSM KMS stub (`ProviderUnavailable` until wire activation).
pub struct HsmKmsProvider {
    config: HsmKmsConfig,
    _client: reqwest::Client,
}

impl fmt::Debug for HsmKmsProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HsmKmsProvider")
            .field("config", &self.config)
            .finish()
    }
}

impl HsmKmsProvider {
    pub fn new(config: HsmKmsConfig) -> Result<Self, CryptoError> {
        validate_https_endpoint(&config.endpoint_url)?;
        let client = build_tls_client()?;
        Ok(Self {
            config,
            _client: client,
        })
    }
}

impl AsyncKmsProvider for HsmKmsProvider {
    fn active_kek_id(&self) -> &KekId {
        &self.config.key_id
    }

    fn wrap_dek<'a>(
        &'a self,
        _purpose: &'a str,
        _dek: &'a secrecy::SecretBox<[u8; 32]>,
    ) -> KmsFuture<'a, Result<WrappedDek, CryptoError>> {
        Box::pin(async { Err(CryptoError::ProviderUnavailable) })
    }

    fn unwrap_dek<'a>(
        &'a self,
        _kek_id: &'a KekId,
        _purpose: &'a str,
        _wrapped_dek: &'a [u8],
    ) -> KmsFuture<'a, Result<secrecy::SecretBox<[u8; 32]>, CryptoError>> {
        Box::pin(async { Err(CryptoError::ProviderUnavailable) })
    }
}
