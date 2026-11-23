// SPDX-License-Identifier: LicenseRef-Proprietary
//! Multi-key rotation keyring backed by `CONSOLE_*_KEYRING` JSON and/or
//! `CONSOLE_*_MASTER_KEY` fallback (`"legacy-env-v1"`).

use core::fmt;
use std::collections::BTreeMap;

use aws_lc_rs::constant_time::verify_slices_are_equal;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use secrecy::{ExposeSecret, SecretBox, SecretString};
use serde::Deserialize;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::error::CryptoError;
use crate::header::KekId;
use crate::kms::{KmsProvider, WrappedDek};
use crate::kwp::{unwrap_dek_kwp, wrap_dek_kwp};

const KEY_LEN: usize = 32;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyringJsonPayload {
    active: String,
    keys: BTreeMap<String, String>,
}

impl Drop for KeyringJsonPayload {
    fn drop(&mut self) {
        self.active.zeroize();
        for mut val in core::mem::take(&mut self.keys).into_values() {
            val.zeroize();
        }
    }
}

impl ZeroizeOnDrop for KeyringJsonPayload {}

/// In-memory multi-key rotation ring implementing [`KmsProvider`].
///
/// Key bytes are stored inside [`SecretBox`] and redacted in [`fmt::Debug`].
pub struct LocalKeyringProvider {
    active_kek_id: KekId,
    keys: BTreeMap<KekId, SecretBox<[u8; KEY_LEN]>>,
}

impl fmt::Debug for LocalKeyringProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ids: Vec<&str> = self.keys.keys().map(KekId::as_str).collect();
        f.debug_struct("LocalKeyringProvider")
            .field("active_kek_id", &self.active_kek_id.as_str())
            .field("key_ids", &ids)
            .field("keys", &"[REDACTED]")
            .finish()
    }
}

impl LocalKeyringProvider {
    /// Construct a single-key ring directly from raw 32-byte key material.
    #[must_use]
    pub fn from_single_key(kek_id: KekId, key: SecretBox<[u8; KEY_LEN]>) -> Self {
        let mut keys = BTreeMap::new();
        keys.insert(kek_id.clone(), key);
        Self {
            active_kek_id: kek_id,
            keys,
        }
    }

    /// Construct a single-key ring from a base64-encoded 32-byte key.
    pub fn from_single_base64(kek_id: KekId, encoded: &str) -> Result<Self, CryptoError> {
        let key = decode_b64_key(encoded)?;
        Ok(Self::from_single_key(kek_id, key))
    }

    /// Parse a JSON keyring `{"active":"<kek_id>","keys":{"<kek_id>":"<b64>",...}}`.
    pub fn from_keyring_json(json: &str) -> Result<Self, CryptoError> {
        let payload: KeyringJsonPayload =
            serde_json::from_str(json).map_err(|_| CryptoError::InvalidKeyMaterial)?;
        let active_kek_id =
            KekId::new(payload.active.as_str()).map_err(|_| CryptoError::InvalidKeyMaterial)?;
        if payload.keys.is_empty() {
            return Err(CryptoError::InvalidKeyMaterial);
        }
        let mut keys = BTreeMap::new();
        for (raw_id, b64) in &payload.keys {
            let kek_id =
                KekId::new(raw_id.as_str()).map_err(|_| CryptoError::InvalidKeyMaterial)?;
            let key = decode_b64_key(b64)?;
            keys.insert(kek_id, key);
        }
        if !keys.contains_key(&active_kek_id) {
            return Err(CryptoError::InvalidKeyMaterial);
        }
        Ok(Self {
            active_kek_id,
            keys,
        })
    }

    /// Combine optional keyring JSON and optional legacy single-key base64 material.
    ///
    /// When both are supplied, the legacy key is retained under `"legacy-env-v1"`
    /// unless already defined in the JSON ring; conflicting bytes under
    /// `"legacy-env-v1"` fail closed with [`CryptoError::InvalidKeyMaterial`].
    pub fn from_env_values(
        keyring_json: Option<Zeroizing<String>>,
        legacy_master_b64: Option<Zeroizing<String>>,
    ) -> Result<Option<Self>, CryptoError> {
        match (keyring_json, legacy_master_b64) {
            (None, None) => Ok(None),
            (None, Some(master)) => {
                Self::from_single_base64(KekId::legacy_default(), &master).map(Some)
            }
            (Some(json), None) => Self::from_keyring_json(&json).map(Some),
            (Some(json), Some(master)) => {
                let mut ring = Self::from_keyring_json(&json)?;
                let legacy_id = KekId::legacy_default();
                let legacy_key = decode_b64_key(&master)?;
                if let Some(existing) = ring.keys.get(&legacy_id) {
                    verify_slices_are_equal(existing.expose_secret(), legacy_key.expose_secret())
                        .map_err(|_| CryptoError::InvalidKeyMaterial)?;
                } else {
                    ring.keys.insert(legacy_id, legacy_key);
                }
                Ok(Some(ring))
            }
        }
    }

    /// Load keyring / legacy master key using a caller-supplied secret reader
    /// (e.g. `secret_env` supporting `<VAR>_FILE`).
    pub fn from_env_vars(
        keyring_var: &str,
        legacy_master_var: &str,
        read_secret: impl Fn(&str) -> Result<Option<SecretString>, CryptoError>,
    ) -> Result<Option<Self>, CryptoError> {
        let keyring =
            read_secret(keyring_var)?.map(|s| Zeroizing::new(s.expose_secret().to_owned()));
        let legacy =
            read_secret(legacy_master_var)?.map(|s| Zeroizing::new(s.expose_secret().to_owned()));
        Self::from_env_values(keyring, legacy)
    }

    /// Look up raw KEK material for a specific `kek_id` (legacy v1/v2 compatibility).
    #[must_use]
    pub fn get_key(&self, kek_id: &KekId) -> Option<&SecretBox<[u8; KEY_LEN]>> {
        self.keys.get(kek_id)
    }

    /// Iterate over `(kek_id, key)` pairs in deterministic order.
    pub fn iter_keys(&self) -> impl Iterator<Item = (&KekId, &SecretBox<[u8; KEY_LEN]>)> {
        self.keys.iter()
    }
}

impl KmsProvider for LocalKeyringProvider {
    fn active_kek_id(&self) -> &KekId {
        &self.active_kek_id
    }

    fn wrap_dek(
        &self,
        purpose: &str,
        dek: &SecretBox<[u8; KEY_LEN]>,
    ) -> Result<WrappedDek, CryptoError> {
        let master = self
            .keys
            .get(&self.active_kek_id)
            .ok_or(CryptoError::KeyNotFound)?;
        let ciphertext = wrap_dek_kwp(master, &self.active_kek_id, purpose, dek)?;
        Ok(WrappedDek {
            kek_id: self.active_kek_id.clone(),
            ciphertext,
        })
    }

    fn unwrap_dek(
        &self,
        kek_id: &KekId,
        purpose: &str,
        wrapped_dek: &[u8],
    ) -> Result<SecretBox<[u8; KEY_LEN]>, CryptoError> {
        let master = self.keys.get(kek_id).ok_or(CryptoError::KeyNotFound)?;
        unwrap_dek_kwp(master, kek_id, purpose, wrapped_dek)
    }
}

fn decode_b64_key(encoded: &str) -> Result<SecretBox<[u8; KEY_LEN]>, CryptoError> {
    let mut decoded = Zeroizing::new(Vec::new());
    BASE64
        .decode_vec(encoded.trim(), &mut decoded)
        .map_err(|_| CryptoError::InvalidKeyMaterial)?;
    let key: Zeroizing<[u8; KEY_LEN]> = Zeroizing::new(
        decoded
            .as_slice()
            .try_into()
            .map_err(|_| CryptoError::InvalidKeyMaterial)?,
    );
    Ok(SecretBox::new(Box::new(*key)))
}
