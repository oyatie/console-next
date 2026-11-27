// SPDX-License-Identifier: LicenseRef-Proprietary
//! AWS-ESDK-v2 (`alg_id = 3`) key-committing AEAD cipher configuration and
//! contact validation/masking helpers for `recovery_contacts`.

use std::sync::Arc;

use console_platform_crypto::{EnvelopeContext, KekId, KmsProvider, LocalKeyringProvider};
use secrecy::{SecretBox, SecretString};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::ProvisioningError;

pub const RECOVERY_CONTACT_NOTICE_VERSION: &str = "recovery-contact-v1";
pub const KEYRING_ENV: &str = "CONSOLE_RECOVERY_CONTACT_KEYRING";
pub const MASTER_KEY_ENV: &str = "CONSOLE_RECOVERY_CONTACT_MASTER_KEY";
pub(super) const ALG_WIRE: &str = "aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum RecoveryChannel {
    Email,
    Phone,
}

impl RecoveryChannel {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Email => "EMAIL",
            Self::Phone => "PHONE",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, ProvisioningError> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "EMAIL" => Ok(Self::Email),
            "PHONE" => Ok(Self::Phone),
            _ => Err(ProvisioningError::InvalidInput(
                "recovery contact channel must be EMAIL or PHONE".to_owned(),
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RecoveryContactStatus {
    pub channel: RecoveryChannel,
    pub masked_value: String,
    #[serde(with = "time::serde::rfc3339")]
    pub confirmed_at: OffsetDateTime,
    pub notice_version: String,
    pub review_pending: bool,
}

#[derive(Clone)]
pub struct RecoveryContactCipher {
    kms: Option<Arc<dyn KmsProvider>>,
}

impl std::fmt::Debug for RecoveryContactCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecoveryContactCipher")
            .field("configured", &self.kms.is_some())
            .finish()
    }
}

impl RecoveryContactCipher {
    #[must_use]
    pub fn from_kms(kms: Arc<dyn KmsProvider>) -> Self {
        Self { kms: Some(kms) }
    }

    #[must_use]
    pub const fn unconfigured() -> Self {
        Self { kms: None }
    }

    pub fn from_env() -> Result<Self, ProvisioningError> {
        let read = |name: &str| match std::env::var(name) {
            Ok(v) if !v.trim().is_empty() => Ok(Some(SecretString::from(v))),
            Ok(_) | Err(std::env::VarError::NotPresent) => Ok(None),
            Err(_) => Err(console_platform_crypto::CryptoError::InvalidInput),
        };
        let ring = LocalKeyringProvider::from_env_vars(KEYRING_ENV, MASTER_KEY_ENV, read).map_err(
            |_| {
                ProvisioningError::Conflict(
                    "invalid recovery contact encryption keyring".to_owned(),
                )
            },
        )?;
        if let Some(provider) = ring {
            return Ok(Self::from_kms(Arc::new(provider)));
        }
        #[cfg(debug_assertions)]
        {
            Self::dev_ephemeral()
        }
        #[cfg(not(debug_assertions))]
        {
            Ok(Self::unconfigured())
        }
    }

    #[cfg(debug_assertions)]
    pub fn dev_ephemeral() -> Result<Self, ProvisioningError> {
        use aws_lc_rs::rand::{SecureRandom, SystemRandom};
        static DEV_KEY: std::sync::OnceLock<Result<[u8; 32], ()>> = std::sync::OnceLock::new();
        let bytes = DEV_KEY.get_or_init(|| {
            let mut buf = [0u8; 32];
            SystemRandom::new().fill(&mut buf).map_err(|_| ())?;
            Ok(buf)
        });
        let raw = bytes.map_err(|()| {
            ProvisioningError::Conflict("CSPRNG unavailable for dev recovery key".to_owned())
        })?;
        let kek = KekId::new("dev-recovery-v1")
            .map_err(|_| ProvisioningError::Conflict("invalid dev kek id".to_owned()))?;
        Ok(Self::from_kms(Arc::new(
            LocalKeyringProvider::from_single_key(kek, SecretBox::new(Box::new(raw))),
        )))
    }

    pub(super) fn kms(&self) -> Result<&dyn KmsProvider, ProvisioningError> {
        self.kms.as_deref().ok_or_else(|| {
            ProvisioningError::Conflict("recovery contact encryption is not configured".to_owned())
        })
    }
}

pub(super) fn envelope_ctx<'a>(tenant_id: &'a str, record: &'a str) -> EnvelopeContext<'a> {
    EnvelopeContext {
        tenant_id,
        table: "recovery_contacts",
        record,
        field: "contact_value",
        purpose: "recovery_contact",
    }
}

pub fn normalize_and_validate_contact(
    channel: RecoveryChannel,
    raw: &str,
) -> Result<String, ProvisioningError> {
    let trimmed = raw.trim();
    match channel {
        RecoveryChannel::Email => {
            let lower = trimmed.to_ascii_lowercase();
            let Some((local, domain)) = lower.split_once('@') else {
                return Err(ProvisioningError::InvalidInput(
                    "invalid recovery email address".to_owned(),
                ));
            };
            if local.is_empty()
                || domain.len() < 3
                || !domain.contains('.')
                || lower.len() > 254
                || lower.chars().any(char::is_whitespace)
            {
                return Err(ProvisioningError::InvalidInput(
                    "invalid recovery email address".to_owned(),
                ));
            }
            Ok(lower)
        }
        RecoveryChannel::Phone => {
            let digits: String = trimmed.chars().filter(char::is_ascii_digit).collect();
            if !(10..=11).contains(&digits.len()) || !digits.starts_with("01") {
                return Err(ProvisioningError::InvalidInput(
                    "invalid recovery phone number".to_owned(),
                ));
            }
            Ok(digits)
        }
    }
}

#[must_use]
pub fn mask_recovery_contact(channel: RecoveryChannel, normalized: &str) -> String {
    match channel {
        RecoveryChannel::Email => {
            let (local, domain) = normalized.split_once('@').unwrap_or((normalized, ""));
            let head: String = local.chars().take(1).collect();
            format!("{head}●●●●@{domain}")
        }
        RecoveryChannel::Phone => {
            let prefix = &normalized[..3.min(normalized.len())];
            let tail = &normalized[normalized.len().saturating_sub(4)..];
            format!("{prefix}-●●●●-{tail}")
        }
    }
}
