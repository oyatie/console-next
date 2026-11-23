// SPDX-License-Identifier: LicenseRef-Proprietary
//! Decoupled KEK identifier (`KekId`), envelope headers, and `"CEV2"` binary wire codec.

use core::fmt;
use serde::{Deserialize, Deserializer, Serialize};

use crate::error::CryptoError;
use crate::suite::AlgId;

/// Legacy KEK identifier assigned when wrapping/reading from `CONSOLE_*_MASTER_KEY`.
pub const DEFAULT_LEGACY_KEK_ID: &str = "legacy-env-v1";
const MAX_KEK_ID_LEN: usize = 128;
const WIRE_MAGIC: [u8; 4] = *b"CEV2";
const WIRE_VERSION_1: u8 = 1;

/// Validated ASCII KEK identifier (`1..=128` bytes, `[A-Za-z0-9._:/-]`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct KekId(String);

impl KekId {
    /// Construct and validate a KEK identifier.
    pub fn new(raw: impl Into<String>) -> Result<Self, CryptoError> {
        let s = raw.into();
        if s.is_empty()
            || s.len() > MAX_KEK_ID_LEN
            || !s
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-'))
        {
            return Err(CryptoError::InvalidInput);
        }
        Ok(Self(s))
    }

    /// Default identifier for legacy single-key environment configuration.
    #[must_use]
    pub fn legacy_default() -> Self {
        Self(DEFAULT_LEGACY_KEK_ID.to_owned())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

impl AsRef<str> for KekId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for KekId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for KekId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::new(s).map_err(|_| serde::de::Error::custom("invalid kek_id"))
    }
}

/// Decoupled envelope metadata header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeHeader {
    pub wire_version: u8,
    pub alg_id: AlgId,
    pub kek_id: KekId,
    pub msg_id: [u8; 32],
    pub commitment_tag: [u8; 32],
    pub nonce: [u8; 12],
    pub wrapped_dek: Vec<u8>,
}

/// Complete sealed envelope (header + AEAD ciphertext including authentication tag).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedEnvelope {
    pub header: EnvelopeHeader,
    pub ciphertext: Vec<u8>,
}

/// Self-describing binary wire codec (`"CEV2"`) for single-column envelope storage.
pub struct EnvelopeWire;

impl EnvelopeWire {
    /// Encode a [`SealedEnvelope`] into `"CEV2"` binary wire format.
    pub fn encode(envelope: &SealedEnvelope) -> Result<Vec<u8>, CryptoError> {
        let h = &envelope.header;
        if h.wire_version != WIRE_VERSION_1 {
            return Err(CryptoError::InvalidInput);
        }
        let kek_bytes = h.kek_id.as_bytes();
        let kek_len = u16::try_from(kek_bytes.len()).map_err(|_| CryptoError::InvalidInput)?;
        let dek_len = u16::try_from(h.wrapped_dek.len()).map_err(|_| CryptoError::InvalidInput)?;
        let cap = 4
            + 1
            + 2
            + 2
            + kek_bytes.len()
            + 32
            + 32
            + 12
            + 2
            + h.wrapped_dek.len()
            + envelope.ciphertext.len();
        let mut out = Vec::with_capacity(cap);
        out.extend_from_slice(&WIRE_MAGIC);
        out.push(h.wire_version);
        out.extend_from_slice(&h.alg_id.as_u16().to_be_bytes());
        out.extend_from_slice(&kek_len.to_be_bytes());
        out.extend_from_slice(kek_bytes);
        out.extend_from_slice(&h.msg_id);
        out.extend_from_slice(&h.commitment_tag);
        out.extend_from_slice(&h.nonce);
        out.extend_from_slice(&dek_len.to_be_bytes());
        out.extend_from_slice(&h.wrapped_dek);
        out.extend_from_slice(&envelope.ciphertext);
        Ok(out)
    }

    /// Decode a `"CEV2"` binary wire payload into a [`SealedEnvelope`].
    pub fn decode(bytes: &[u8]) -> Result<SealedEnvelope, CryptoError> {
        let mut cursor = bytes;
        let magic = take_exact::<4>(&mut cursor)?;
        if magic != WIRE_MAGIC {
            return Err(CryptoError::Decrypt);
        }
        let wire_version = take_exact::<1>(&mut cursor)?[0];
        if wire_version != WIRE_VERSION_1 {
            return Err(CryptoError::UnsupportedAlgorithm);
        }
        let alg_id = AlgId::from_u16(u16::from_be_bytes(take_exact::<2>(&mut cursor)?))?;
        let kek_len = usize::from(u16::from_be_bytes(take_exact::<2>(&mut cursor)?));
        let kek_slice = take_slice(&mut cursor, kek_len)?;
        let kek_str = core::str::from_utf8(kek_slice).map_err(|_| CryptoError::Decrypt)?;
        let kek_id = KekId::new(kek_str).map_err(|_| CryptoError::Decrypt)?;
        let msg_id = take_exact::<32>(&mut cursor)?;
        let commitment_tag = take_exact::<32>(&mut cursor)?;
        let nonce = take_exact::<12>(&mut cursor)?;
        let dek_len = usize::from(u16::from_be_bytes(take_exact::<2>(&mut cursor)?));
        let wrapped_dek = take_slice(&mut cursor, dek_len)?.to_vec();
        let ciphertext = cursor.to_vec();
        Ok(SealedEnvelope {
            header: EnvelopeHeader {
                wire_version,
                alg_id,
                kek_id,
                msg_id,
                commitment_tag,
                nonce,
                wrapped_dek,
            },
            ciphertext,
        })
    }
}

fn take_exact<const N: usize>(cursor: &mut &[u8]) -> Result<[u8; N], CryptoError> {
    let slice = take_slice(cursor, N)?;
    slice.try_into().map_err(|_| CryptoError::Decrypt)
}

fn take_slice<'a>(cursor: &mut &'a [u8], len: usize) -> Result<&'a [u8], CryptoError> {
    let (head, tail) = cursor.split_at_checked(len).ok_or(CryptoError::Decrypt)?;
    *cursor = tail;
    Ok(head)
}
