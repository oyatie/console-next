// SPDX-License-Identifier: LicenseRef-Proprietary
//! Hash-verified in-memory cache of unwrapped per-tenant DEKs.

use core::fmt;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use aws_lc_rs::{
    constant_time::verify_slices_are_equal,
    digest::{SHA256, digest},
};
use secrecy::SecretBox;
use uuid::Uuid;

use crate::header::KekId;
use crate::tenant_kek::TenantKeyScope;

/// Compute the 32-byte SHA-256 digest of wrapped tenant DEK bytes for cache verification.
#[must_use]
pub fn wrapped_dek_sha256(wrapped_dek: &[u8]) -> [u8; 32] {
    let d = digest(&SHA256, wrapped_dek);
    let mut out = [0u8; 32];
    out.copy_from_slice(d.as_ref());
    out
}

/// Compute the 32-byte non-secret key fingerprint stored in `tenant_encryption_keys.key_fingerprint`.
#[must_use]
pub fn tenant_key_fingerprint(
    org_id: Uuid,
    scope: TenantKeyScope,
    key_version: i32,
    master_kek_id: &KekId,
    wrapped_dek: &[u8],
) -> [u8; 32] {
    let mut material = Vec::with_capacity(96 + wrapped_dek.len());
    material.extend_from_slice(b"console.tenant_dek.fingerprint.v1:");
    material.extend_from_slice(org_id.as_bytes());
    material.extend_from_slice(scope.as_str().as_bytes());
    material.extend_from_slice(&key_version.to_be_bytes());
    material.extend_from_slice(master_kek_id.as_bytes());
    material.extend_from_slice(wrapped_dek);
    let d = digest(&SHA256, &material);
    let mut out = [0u8; 32];
    out.copy_from_slice(d.as_ref());
    out
}

#[derive(Clone)]
struct CachedDekEntry {
    wrapped_sha256: [u8; 32],
    unwrapped: Arc<SecretBox<[u8; 32]>>,
}

/// Thread-safe in-memory cache of unwrapped tenant DEKs, keyed by
/// `(org_id, scope, key_version)` and verified against the live DB
/// `sha256(wrapped_dek)` on every lookup.
#[derive(Default)]
pub struct TenantDekCache {
    entries: RwLock<BTreeMap<(Uuid, TenantKeyScope, i32), CachedDekEntry>>,
}

impl fmt::Debug for TenantDekCache {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let len = self.entries.read().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("TenantDekCache")
            .field("entries", &len)
            .finish()
    }
}

impl TenantDekCache {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the cached tenant DEK only when the live DB `wrapped_dek` SHA-256 matches.
    #[must_use]
    pub fn get_if_hash_matches(
        &self,
        org_id: Uuid,
        scope: TenantKeyScope,
        key_version: i32,
        wrapped_dek: &[u8],
    ) -> Option<Arc<SecretBox<[u8; 32]>>> {
        let expected = wrapped_dek_sha256(wrapped_dek);
        let guard = self.entries.read().ok()?;
        let entry = guard.get(&(org_id, scope, key_version))?;
        verify_slices_are_equal(&entry.wrapped_sha256, &expected)
            .ok()
            .map(|()| Arc::clone(&entry.unwrapped))
    }

    /// Cache an unwrapped tenant DEK tagged with `sha256(wrapped_dek)`.
    pub fn insert(
        &self,
        org_id: Uuid,
        scope: TenantKeyScope,
        key_version: i32,
        wrapped_dek: &[u8],
        dek: Arc<SecretBox<[u8; 32]>>,
    ) {
        let wrapped_sha256 = wrapped_dek_sha256(wrapped_dek);
        if let Ok(mut guard) = self.entries.write() {
            guard.insert(
                (org_id, scope, key_version),
                CachedDekEntry {
                    wrapped_sha256,
                    unwrapped: dek,
                },
            );
        }
    }

    /// Evict all cached tenant DEKs for `org_id`.
    pub fn evict_org(&self, org_id: Uuid) {
        if let Ok(mut guard) = self.entries.write() {
            guard.retain(|(org, _, _), _| *org != org_id);
        }
    }

    /// Clear all cached entries.
    pub fn clear(&self) {
        if let Ok(mut guard) = self.entries.write() {
            guard.clear();
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn cache_verifies_wrapped_dek_hash_and_evicts_org() {
        let cache = TenantDekCache::new();
        let org = Uuid::new_v4();
        let dek = Arc::new(SecretBox::new(Box::new([0x55u8; 32])));
        cache.insert(org, TenantKeyScope::Mail, 1, b"wrapped-v1", dek);
        assert!(
            cache
                .get_if_hash_matches(org, TenantKeyScope::Mail, 1, b"wrapped-v1")
                .is_some()
        );
        assert!(
            cache
                .get_if_hash_matches(org, TenantKeyScope::Mail, 1, b"other-bytes")
                .is_none()
        );
        cache.evict_org(org);
        assert!(
            cache
                .get_if_hash_matches(org, TenantKeyScope::Mail, 1, b"wrapped-v1")
                .is_none()
        );
    }
}
