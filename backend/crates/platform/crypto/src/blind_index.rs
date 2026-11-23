// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant- and context-bound blind indexing (`HKDF-SHA256` subkey derivation +
//! `HMAC-SHA256`) with multi-version keyring rotation and legacy v1 support.

use core::fmt;
use std::collections::BTreeMap;

use aws_lc_rs::constant_time::verify_slices_are_equal;
use aws_lc_rs::{hkdf, hmac};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use secrecy::{ExposeSecret, SecretBox, SecretString};
use serde::Deserialize;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::aad::push_lp_u32;
use crate::error::CryptoError;
use crate::kwp::KeyLen;

/// Required byte length of each HMAC blind-index root key.
pub const BLIND_INDEX_KEY_LEN: usize = 32;
/// Output byte length of each HMAC-SHA256 blind-index tag.
pub const BLIND_INDEX_DIGEST_LEN: usize = 32;
/// Legacy un-tenanted blind-index version (`HMAC-SHA256(key_1, digits)`).
pub const LEGACY_HMAC_KEY_VERSION: i16 = 1;
/// Default tenant-bound HKDF-SHA256 blind-index version (`>= 2`).
pub const DEFAULT_TENANT_BLIND_INDEX_VERSION: i16 = 2;

const BLIND_INDEX_HKDF_SALT: &[u8] = b"console.crypto.blind_index.salt.v2";
const BLIND_INDEX_INFO_DOMAIN: &[u8] = b"console.crypto.blind_index.v2";

/// Tenant and schema context bound into every v2+ blind-index subkey.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlindIndexContext<'a> {
    pub org_id: Uuid,
    pub table: &'a str,
    pub field: &'a str,
}

impl BlindIndexContext<'_> {
    fn validate(self) -> Result<(), CryptoError> {
        if self.table.is_empty() || self.field.is_empty() {
            return Err(CryptoError::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HmacKeyringJsonPayload {
    active: i16,
    keys: BTreeMap<String, String>,
}

impl Drop for HmacKeyringJsonPayload {
    fn drop(&mut self) {
        self.active.zeroize();
        for mut val in core::mem::take(&mut self.keys).into_values() {
            val.zeroize();
        }
    }
}

impl ZeroizeOnDrop for HmacKeyringJsonPayload {}

/// Multi-version HMAC blind-index keyring (`SecretBox` keys, redacted `Debug`).
pub struct BlindIndexKeyring {
    active_version: i16,
    keys: BTreeMap<i16, SecretBox<[u8; BLIND_INDEX_KEY_LEN]>>,
}

impl fmt::Debug for BlindIndexKeyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let versions: Vec<i16> = self.keys.keys().copied().collect();
        f.debug_struct("BlindIndexKeyring")
            .field("active_version", &self.active_version)
            .field("versions", &versions)
            .field("keys", &"[REDACTED]")
            .finish()
    }
}

impl BlindIndexKeyring {
    /// Construct a keyring from a single legacy `CONSOLE_RRN_HMAC_KEY` base64 secret.
    ///
    /// Registers version `1` (legacy raw HMAC-SHA256 reader/N-1 writer) and
    /// version `2` (HKDF-SHA256 root for tenant-bound v2), setting
    /// `active_version = 2`.
    pub fn from_single_legacy_base64(encoded: &str) -> Result<Self, CryptoError> {
        let raw = decode_b64_bytes(encoded)?;
        let mut keys = BTreeMap::new();
        keys.insert(LEGACY_HMAC_KEY_VERSION, SecretBox::new(Box::new(*raw)));
        keys.insert(
            DEFAULT_TENANT_BLIND_INDEX_VERSION,
            SecretBox::new(Box::new(*raw)),
        );
        Ok(Self {
            active_version: DEFAULT_TENANT_BLIND_INDEX_VERSION,
            keys,
        })
    }

    /// Parse a JSON keyring `{"active": 2, "keys": {"1": "<b64>", "2": "<b64>"}}`.
    pub fn from_keyring_json(json: &str) -> Result<Self, CryptoError> {
        let payload: HmacKeyringJsonPayload =
            serde_json::from_str(json).map_err(|_| CryptoError::InvalidKeyMaterial)?;
        if payload.active <= 0 || payload.keys.is_empty() {
            return Err(CryptoError::InvalidKeyMaterial);
        }
        let mut keys = BTreeMap::new();
        for (raw_ver, b64) in &payload.keys {
            let ver = raw_ver
                .parse::<i16>()
                .map_err(|_| CryptoError::InvalidKeyMaterial)?;
            if ver <= 0 || ver.to_string() != *raw_ver || keys.contains_key(&ver) {
                return Err(CryptoError::InvalidKeyMaterial);
            }
            let key = decode_b64_key(b64)?;
            keys.insert(ver, key);
        }
        if !keys.contains_key(&payload.active) {
            return Err(CryptoError::InvalidKeyMaterial);
        }
        Ok(Self {
            active_version: payload.active,
            keys,
        })
    }

    /// Combine optional keyring JSON and optional legacy base64 key material.
    ///
    /// When both are supplied, the legacy key is retained under version `1`
    /// unless already defined in the JSON ring; conflicting bytes under
    /// version `1` fail closed with [`CryptoError::InvalidKeyMaterial`].
    pub fn from_env_values(
        keyring_json: Option<Zeroizing<String>>,
        legacy_hmac_b64: Option<Zeroizing<String>>,
    ) -> Result<Option<Self>, CryptoError> {
        match (keyring_json, legacy_hmac_b64) {
            (None, None) => Ok(None),
            (None, Some(legacy)) => Self::from_single_legacy_base64(&legacy).map(Some),
            (Some(json), None) => Self::from_keyring_json(&json).map(Some),
            (Some(json), Some(legacy)) => {
                let mut ring = Self::from_keyring_json(&json)?;
                let legacy_key = decode_b64_key(&legacy)?;
                if let Some(existing) = ring.keys.get(&LEGACY_HMAC_KEY_VERSION) {
                    verify_slices_are_equal(existing.expose_secret(), legacy_key.expose_secret())
                        .map_err(|_| CryptoError::InvalidKeyMaterial)?;
                } else {
                    ring.keys.insert(LEGACY_HMAC_KEY_VERSION, legacy_key);
                }
                Ok(Some(ring))
            }
        }
    }

    /// Convenience wrapper for callers holding owned `String` values without
    /// pulling `zeroize` into their own dependency list.
    pub fn from_owned_env_values(
        keyring_json: Option<String>,
        legacy_hmac_b64: Option<String>,
    ) -> Result<Option<Self>, CryptoError> {
        Self::from_env_values(
            keyring_json.map(Zeroizing::new),
            legacy_hmac_b64.map(Zeroizing::new),
        )
    }

    /// Load keyring / legacy key using a caller-supplied secret reader.
    pub fn from_env_vars(
        keyring_var: &str,
        legacy_var: &str,
        read_secret: impl Fn(&str) -> Result<Option<SecretString>, CryptoError>,
    ) -> Result<Option<Self>, CryptoError> {
        let keyring =
            read_secret(keyring_var)?.map(|s| Zeroizing::new(s.expose_secret().to_owned()));
        let legacy = read_secret(legacy_var)?.map(|s| Zeroizing::new(s.expose_secret().to_owned()));
        Self::from_env_values(keyring, legacy)
    }

    /// The active key version used for writes.
    #[must_use]
    pub fn active_version(&self) -> i16 {
        self.active_version
    }

    /// Whether `version` is registered in this keyring.
    #[must_use]
    pub fn has_version(&self, version: i16) -> bool {
        self.keys.contains_key(&version)
    }

    /// Registered key versions in ascending order.
    pub fn versions(&self) -> impl Iterator<Item = i16> + '_ {
        self.keys.keys().copied()
    }

    /// Compute the 32-byte blind-index tag for a specific `version`.
    ///
    /// * `version == 1`: raw `HMAC-SHA256(key_1, value)` (legacy compatibility).
    /// * `version >= 2`: `HKDF-SHA256` tenant/table/field/version subkey -> `HMAC-SHA256`.
    pub fn compute_for_version(
        &self,
        version: i16,
        ctx: BlindIndexContext<'_>,
        value: &[u8],
    ) -> Result<[u8; BLIND_INDEX_DIGEST_LEN], CryptoError> {
        ctx.validate()?;
        if version <= 0 {
            return Err(CryptoError::InvalidInput);
        }
        let master = self.keys.get(&version).ok_or(CryptoError::KeyNotFound)?;
        if version == LEGACY_HMAC_KEY_VERSION {
            let tag = hmac::sign(
                &hmac::Key::new(hmac::HMAC_SHA256, master.expose_secret()),
                value,
            );
            let mut out = [0u8; BLIND_INDEX_DIGEST_LEN];
            out.copy_from_slice(tag.as_ref());
            return Ok(out);
        }
        let subkey = derive_subkey(master, ctx, version)?;
        let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, subkey.as_ref()), value);
        let mut out = [0u8; BLIND_INDEX_DIGEST_LEN];
        out.copy_from_slice(tag.as_ref());
        Ok(out)
    }

    /// Compute `(active_version, digest)` under the active key version.
    pub fn compute_active(
        &self,
        ctx: BlindIndexContext<'_>,
        value: &[u8],
    ) -> Result<(i16, [u8; BLIND_INDEX_DIGEST_LEN]), CryptoError> {
        let digest = self.compute_for_version(self.active_version, ctx, value)?;
        Ok((self.active_version, digest))
    }

    /// Compute `(version, digest)` for all `version >= 2` in descending order.
    pub fn compute_v2_candidates(
        &self,
        ctx: BlindIndexContext<'_>,
        value: &[u8],
    ) -> Result<Vec<(i16, [u8; BLIND_INDEX_DIGEST_LEN])>, CryptoError> {
        ctx.validate()?;
        let mut out = Vec::new();
        for version in self.keys.keys().copied().rev().filter(|&v| v >= 2) {
            out.push((version, self.compute_for_version(version, ctx, value)?));
        }
        Ok(out)
    }

    /// Compute `(version, digest)` across all registered versions (active first,
    /// then remaining versions in descending order).
    pub fn compute_all_candidates(
        &self,
        ctx: BlindIndexContext<'_>,
        value: &[u8],
    ) -> Result<Vec<(i16, [u8; BLIND_INDEX_DIGEST_LEN])>, CryptoError> {
        ctx.validate()?;
        let mut out = Vec::with_capacity(self.keys.len());
        out.push((
            self.active_version,
            self.compute_for_version(self.active_version, ctx, value)?,
        ));
        for version in self
            .keys
            .keys()
            .copied()
            .rev()
            .filter(|&v| v != self.active_version)
        {
            out.push((version, self.compute_for_version(version, ctx, value)?));
        }
        Ok(out)
    }
}

fn derive_subkey(
    master: &SecretBox<[u8; BLIND_INDEX_KEY_LEN]>,
    ctx: BlindIndexContext<'_>,
    version: i16,
) -> Result<Zeroizing<[u8; BLIND_INDEX_KEY_LEN]>, CryptoError> {
    ctx.validate()?;
    if version < 2 {
        return Err(CryptoError::InvalidInput);
    }
    let version_u16 = u16::try_from(version).map_err(|_| CryptoError::InvalidInput)?;
    let mut info = Vec::with_capacity(
        BLIND_INDEX_INFO_DOMAIN.len() + 12 + 16 + ctx.table.len() + ctx.field.len() + 2,
    );
    info.extend_from_slice(BLIND_INDEX_INFO_DOMAIN);
    push_lp_u32(&mut info, ctx.org_id.as_bytes())?;
    push_lp_u32(&mut info, ctx.table.as_bytes())?;
    push_lp_u32(&mut info, ctx.field.as_bytes())?;
    info.extend_from_slice(&version_u16.to_be_bytes());

    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, BLIND_INDEX_HKDF_SALT);
    let prk = salt.extract(master.expose_secret());
    let slices = [info.as_slice()];
    let okm = prk
        .expand(&slices, KeyLen(BLIND_INDEX_KEY_LEN))
        .map_err(|_| CryptoError::Encrypt)?;
    let mut subkey = Zeroizing::new([0u8; BLIND_INDEX_KEY_LEN]);
    okm.fill(subkey.as_mut())
        .map_err(|_| CryptoError::Encrypt)?;
    Ok(subkey)
}

fn decode_b64_bytes(encoded: &str) -> Result<Zeroizing<[u8; BLIND_INDEX_KEY_LEN]>, CryptoError> {
    let mut decoded = Zeroizing::new(Vec::new());
    BASE64
        .decode_vec(encoded.trim(), &mut decoded)
        .map_err(|_| CryptoError::InvalidKeyMaterial)?;
    let key: [u8; BLIND_INDEX_KEY_LEN] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidKeyMaterial)?;
    Ok(Zeroizing::new(key))
}

fn decode_b64_key(encoded: &str) -> Result<SecretBox<[u8; BLIND_INDEX_KEY_LEN]>, CryptoError> {
    let key = decode_b64_bytes(encoded)?;
    Ok(SecretBox::new(Box::new(*key)))
}
