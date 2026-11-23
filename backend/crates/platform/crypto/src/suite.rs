// SPDX-License-Identifier: LicenseRef-Proprietary
//! Algorithm suite registry (`AlgId`) including legacy and reserved PQ suites.

use serde::{Deserialize, Serialize};

use crate::error::CryptoError;

/// Versioned envelope suite identifier decoupled from KEK rotation (`KekId`).
#[repr(u16)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum AlgId {
    /// Legacy suite 1 (XChaCha20-Poly1305). Decryption stays isolated in the
    /// legacy credential cipher adapter so this SDK needs no ChaCha20 crate.
    LegacyXChaCha20Poly1305 = 1,
    /// Legacy suite 2 (plain AES-256-GCM + raw AES-256-KWP without commitment tag).
    LegacyAes256GcmKwp = 2,
    /// Target AWS-ESDK-v2 key-committing construction:
    /// HKDF-SHA256 per-message enc_key + 256-bit commitment tag + AES-256-GCM
    /// + HKDF-SHA256 domain-separated AES-256-KWP + outer AAD wrap binding.
    AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap = 3,
    /// Reserved post-quantum hybrid suite (ML-KEM-768 DEK encapsulation +
    /// AES-256-GCM + HKDF-SHA384). Fails closed until activated.
    ReservedMlKem768Aes256Gcm = 0x0101,
}

impl AlgId {
    /// Canonical stable string identifier for database `alg_id` columns and audits.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LegacyXChaCha20Poly1305 => "legacy-xchacha20-poly1305",
            Self::LegacyAes256GcmKwp => "legacy-aes256-gcm-kwp",
            Self::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap => {
                "aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp"
            }
            Self::ReservedMlKem768Aes256Gcm => "reserved-mlkem768-aes256-gcm",
        }
    }

    /// Numeric 16-bit suite identifier.
    #[must_use]
    pub const fn as_u16(self) -> u16 {
        self as u16
    }

    /// Lossless conversion to PostgreSQL `SMALLINT` (`i16`).
    pub fn to_i16(self) -> Result<i16, CryptoError> {
        i16::try_from(self.as_u16()).map_err(|_| CryptoError::UnsupportedAlgorithm)
    }

    /// Parse a numeric 16-bit suite identifier.
    pub fn from_u16(raw: u16) -> Result<Self, CryptoError> {
        match raw {
            1 => Ok(Self::LegacyXChaCha20Poly1305),
            2 => Ok(Self::LegacyAes256GcmKwp),
            3 => Ok(Self::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap),
            0x0101 => Ok(Self::ReservedMlKem768Aes256Gcm),
            _ => Err(CryptoError::UnsupportedAlgorithm),
        }
    }

    /// Parse a PostgreSQL `SMALLINT` (`i16`) suite identifier.
    pub fn from_i16(raw: i16) -> Result<Self, CryptoError> {
        let u = u16::try_from(raw).map_err(|_| CryptoError::UnsupportedAlgorithm)?;
        Self::from_u16(u)
    }

    /// Parse a canonical string suite identifier.
    pub fn parse_str(raw: &str) -> Result<Self, CryptoError> {
        match raw {
            "legacy-xchacha20-poly1305" => Ok(Self::LegacyXChaCha20Poly1305),
            "legacy-aes256-gcm-kwp" => Ok(Self::LegacyAes256GcmKwp),
            "aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp" => {
                Ok(Self::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap)
            }
            "reserved-mlkem768-aes256-gcm" => Ok(Self::ReservedMlKem768Aes256Gcm),
            _ => Err(CryptoError::UnsupportedAlgorithm),
        }
    }

    /// Whether this SDK supports sealing new payloads with this suite.
    #[must_use]
    pub const fn is_supported_for_seal(self) -> bool {
        matches!(self, Self::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap)
    }

    /// Whether this suite is a reserved post-quantum suite that must fail closed.
    #[must_use]
    pub const fn is_pq_reserved(self) -> bool {
        matches!(self, Self::ReservedMlKem768Aes256Gcm)
    }
}
