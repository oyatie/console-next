// SPDX-License-Identifier: LicenseRef-Proprietary
//! Crypto-agility envelope SDK, AWS-ESDK-v2 key-committing AEAD, multi-key
//! rotation keyring, and pluggable KMS provider port.

#![forbid(unsafe_code)]

pub mod aad;
pub mod blind_index;
pub mod error;
pub mod esdk_v2;
pub mod header;
pub mod keyring;
pub mod kms;
pub mod kwp;
pub mod providers;
pub mod suite;
pub mod tenant_cache;
pub mod tenant_kek;

pub use aad::{EnvelopeContext, encode_outer_aad};
pub use blind_index::{
    BLIND_INDEX_DIGEST_LEN, BLIND_INDEX_KEY_LEN, BlindIndexContext, BlindIndexKeyring,
    DEFAULT_TENANT_BLIND_INDEX_VERSION, LEGACY_HMAC_KEY_VERSION,
};
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
pub use tenant_cache::{TenantDekCache, tenant_key_fingerprint, wrapped_dek_sha256};
pub use tenant_kek::{
    TENANT_DEK_MODE_ENV, TenantDekMode, TenantKekId, TenantKeyScope, TenantKeyState,
    TenantScopedKms,
};
