// SPDX-License-Identifier: LicenseRef-Proprietary
//! Crypto-agility envelope SDK, AWS-ESDK-v2 key-committing AEAD, multi-key
//! rotation keyring, and pluggable KMS provider port.

#![forbid(unsafe_code)]

pub mod aad;
pub mod error;
pub mod esdk_v2;
pub mod header;
pub mod keyring;
pub mod kms;
pub mod kwp;
pub mod providers;
pub mod suite;

pub use aad::{EnvelopeContext, encode_outer_aad};
pub use error::CryptoError;
pub use esdk_v2::{COMMITMENT_TAG_LEN, DEK_LEN, MSG_ID_LEN, NONCE_LEN, open_v3, seal_v3};
pub use header::{DEFAULT_LEGACY_KEK_ID, EnvelopeHeader, EnvelopeWire, KekId, SealedEnvelope};
pub use keyring::LocalKeyringProvider;
pub use kms::{AsyncKmsProvider, KmsFuture, KmsProvider, WrappedDek};
pub use kwp::{unwrap_dek_kwp, wrap_dek_kwp};
pub use providers::{
    AwsKmsConfig, AwsKmsProvider, HsmKmsConfig, HsmKmsProvider, OciVaultKmsConfig,
    OciVaultKmsProvider,
};
pub use suite::AlgId;
