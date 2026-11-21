// SPDX-License-Identifier: LicenseRef-Proprietary
//! Per-tenant key hierarchy (`TenantScopedKms`), `"tdek:<org>:<scope>:v<ver>"`
//! KEK identifiers, and N-1 rollout mode.

use core::fmt;
use std::collections::BTreeMap;
use std::sync::Arc;

use secrecy::SecretBox;
use uuid::Uuid;

use crate::error::CryptoError;
use crate::header::KekId;
use crate::kms::{KmsProvider, WrappedDek};
use crate::kwp::{unwrap_dek_kwp, wrap_dek_kwp};

/// Environment variable controlling tenant-DEK writer rollout (`active` | `dual_read`).
pub const TENANT_DEK_MODE_ENV: &str = "CONSOLE_TENANT_DEK_MODE";

/// Tenant encryption domain scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TenantKeyScope {
    Rrn,
    Mail,
}

impl TenantKeyScope {
    /// Canonical SQL/wire scope string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rrn => "rrn",
            Self::Mail => "mail",
        }
    }

    /// Parse a scope identifier.
    pub fn parse(raw: &str) -> Result<Self, CryptoError> {
        match raw {
            "rrn" => Ok(Self::Rrn),
            "mail" => Ok(Self::Mail),
            _ => Err(CryptoError::InvalidInput),
        }
    }

    /// Distinct HKDF KWP `purpose` string when wrapping/unwrapping the tenant
    /// DEK itself under the master KEK.
    #[must_use]
    pub const fn tenant_dek_purpose(self) -> &'static str {
        match self {
            Self::Rrn => "tenant_dek.rrn",
            Self::Mail => "tenant_dek.mail",
        }
    }
}

impl fmt::Display for TenantKeyScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Lifecycle state of a row in `tenant_encryption_keys`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TenantKeyState {
    Active,
    Retired,
    Shredded,
}

impl TenantKeyState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "ACTIVE",
            Self::Retired => "RETIRED",
            Self::Shredded => "SHREDDED",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, CryptoError> {
        match raw {
            "ACTIVE" => Ok(Self::Active),
            "RETIRED" => Ok(Self::Retired),
            "SHREDDED" => Ok(Self::Shredded),
            _ => Err(CryptoError::InvalidInput),
        }
    }
}

/// N-1 rolling deployment writer mode for per-tenant DEKs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TenantDekMode {
    /// Default: write new envelopes under the tenant's active DEK (`tdek:...`),
    /// while continuing to dual-read legacy `v1`/`v2`/direct-KEK `v3` rows.
    #[default]
    Active,
    /// Canary N-1 safety mode: write new envelopes under the global master KEK
    /// while reading both direct-KEK and `tdek:...` rows.
    DualRead,
}

impl TenantDekMode {
    /// Canonical mode string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::DualRead => "dual_read",
        }
    }

    /// Parse `CONSOLE_TENANT_DEK_MODE` (`"active"` when unset).
    pub fn from_env() -> Result<Self, CryptoError> {
        match std::env::var(TENANT_DEK_MODE_ENV) {
            Ok(raw) => Self::parse(&raw),
            Err(std::env::VarError::NotPresent) => Ok(Self::Active),
            Err(_) => Err(CryptoError::InvalidInput),
        }
    }

    /// Parse an explicit mode string (`active` | `dual_read`).
    pub fn parse(raw: &str) -> Result<Self, CryptoError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "active" => Ok(Self::Active),
            "dual_read" | "dual-read" => Ok(Self::DualRead),
            _ => Err(CryptoError::InvalidInput),
        }
    }
}

/// Structured tenant KEK identifier (`"tdek:<org_uuid>:<scope>:v<ver>"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TenantKekId {
    pub org_id: Uuid,
    pub scope: TenantKeyScope,
    pub key_version: i32,
}

impl TenantKekId {
    /// Format as a validated [`KekId`].
    #[must_use]
    pub fn to_kek_id(self) -> KekId {
        let formatted = format!("tdek:{}:{}:v{}", self.org_id, self.scope, self.key_version);
        KekId::new(formatted).unwrap_or_else(|_| KekId::legacy_default())
    }

    /// Parse a `kek_id` string. Returns `Ok(None)` when `raw` is not a tenant
    /// DEK identifier (direct master KEK), `Ok(Some(...))` when valid, or
    /// `Err(CryptoError::Decrypt)` if malformed `"tdek:..."`.
    pub fn parse(raw: &str) -> Result<Option<Self>, CryptoError> {
        let Some(rest) = raw.strip_prefix("tdek:") else {
            return Ok(None);
        };
        let mut parts = rest.split(':');
        let (Some(org_raw), Some(scope_raw), Some(ver_raw), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(CryptoError::Decrypt);
        };
        let org_id = Uuid::parse_str(org_raw).map_err(|_| CryptoError::Decrypt)?;
        let scope = TenantKeyScope::parse(scope_raw).map_err(|_| CryptoError::Decrypt)?;
        let ver_digits = ver_raw.strip_prefix('v').ok_or(CryptoError::Decrypt)?;
        if ver_digits.is_empty()
            || ver_digits.starts_with('0')
            || !ver_digits.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(CryptoError::Decrypt);
        }
        let key_version = ver_digits
            .parse::<i32>()
            .map_err(|_| CryptoError::Decrypt)?;
        if key_version < 1 {
            return Err(CryptoError::Decrypt);
        }
        Ok(Some(Self {
            org_id,
            scope,
            key_version,
        }))
    }
}

/// Per-tenant synchronous [`KmsProvider`] resolving `"tdek:<org>:<scope>:v<ver>"`
/// and delegating pre-tenant-DEK master KEK rows when unshredded.
pub struct TenantScopedKms {
    org_id: Uuid,
    scope: TenantKeyScope,
    active_kek_id: KekId,
    active_tenant_version: Option<i32>,
    shredded: bool,
    tenant_deks: BTreeMap<i32, Arc<SecretBox<[u8; 32]>>>,
    master_kms: Arc<dyn KmsProvider>,
}

impl fmt::Debug for TenantScopedKms {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TenantScopedKms")
            .field("org_id", &self.org_id)
            .field("scope", &self.scope)
            .field("active_kek_id", &self.active_kek_id.as_str())
            .field("active_tenant_version", &self.active_tenant_version)
            .field("shredded", &self.shredded)
            .field(
                "loaded_versions",
                &self.tenant_deks.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl TenantScopedKms {
    /// Build a resolved per-tenant KMS provider from DB key material.
    #[must_use]
    pub fn from_resolved(
        org_id: Uuid,
        scope: TenantKeyScope,
        active_tenant_version: Option<i32>,
        shredded: bool,
        tenant_deks: BTreeMap<i32, Arc<SecretBox<[u8; 32]>>>,
        master_kms: Arc<dyn KmsProvider>,
    ) -> Self {
        let active_kek_id = match active_tenant_version {
            Some(ver) if !shredded => TenantKekId {
                org_id,
                scope,
                key_version: ver,
            }
            .to_kek_id(),
            _ => master_kms.active_kek_id().clone(),
        };
        Self {
            org_id,
            scope,
            active_kek_id,
            active_tenant_version: if shredded {
                None
            } else {
                active_tenant_version
            },
            shredded,
            tenant_deks,
            master_kms,
        }
    }

    #[must_use]
    pub fn org_id(&self) -> Uuid {
        self.org_id
    }

    #[must_use]
    pub fn scope(&self) -> TenantKeyScope {
        self.scope
    }

    #[must_use]
    pub fn is_shredded(&self) -> bool {
        self.shredded
    }
}

impl KmsProvider for TenantScopedKms {
    fn active_kek_id(&self) -> &KekId {
        &self.active_kek_id
    }

    fn wrap_dek(
        &self,
        purpose: &str,
        dek: &SecretBox<[u8; 32]>,
    ) -> Result<WrappedDek, CryptoError> {
        if self.shredded {
            return Err(CryptoError::KeyNotFound);
        }
        match self.active_tenant_version {
            Some(ver) => {
                let tdek = self.tenant_deks.get(&ver).ok_or(CryptoError::KeyNotFound)?;
                let ciphertext = wrap_dek_kwp(tdek.as_ref(), &self.active_kek_id, purpose, dek)?;
                Ok(WrappedDek {
                    kek_id: self.active_kek_id.clone(),
                    ciphertext,
                })
            }
            None => self.master_kms.wrap_dek(purpose, dek),
        }
    }

    fn unwrap_dek(
        &self,
        kek_id: &KekId,
        purpose: &str,
        wrapped_dek: &[u8],
    ) -> Result<SecretBox<[u8; 32]>, CryptoError> {
        if self.shredded {
            return Err(CryptoError::Decrypt);
        }
        if let Some(parsed) = TenantKekId::parse(kek_id.as_str())? {
            if parsed.org_id != self.org_id || parsed.scope != self.scope {
                return Err(CryptoError::Decrypt);
            }
            let tdek = self
                .tenant_deks
                .get(&parsed.key_version)
                .ok_or(CryptoError::Decrypt)?;
            return unwrap_dek_kwp(tdek.as_ref(), kek_id, purpose, wrapped_dek);
        }
        self.master_kms.unwrap_dek(kek_id, purpose, wrapped_dek)
    }

    fn is_shredded(&self) -> bool {
        self.shredded
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::{AlgId, EnvelopeContext, LocalKeyringProvider, open_v3, seal_v3};
    use secrecy::ExposeSecret;
    use zeroize::Zeroizing;

    fn test_master_kms() -> Arc<dyn KmsProvider> {
        Arc::new(LocalKeyringProvider::from_single_key(
            KekId::new("k1").unwrap(),
            SecretBox::new(Box::new([0x11u8; 32])),
        ))
    }

    #[test]
    fn tenant_kek_id_round_trips_and_rejects_malformed() {
        let org = Uuid::new_v4();
        let tid = TenantKekId {
            org_id: org,
            scope: TenantKeyScope::Rrn,
            key_version: 2,
        };
        let kek = tid.to_kek_id();
        assert_eq!(TenantKekId::parse(kek.as_str()).unwrap(), Some(tid));
        assert_eq!(TenantKekId::parse("k1").unwrap(), None);
        for bad in [
            "tdek:",
            "tdek:not-a-uuid:rrn:v1",
            &format!("tdek:{org}:unknown:v1"),
            &format!("tdek:{org}:rrn:1"),
            &format!("tdek:{org}:rrn:v0"),
            &format!("tdek:{org}:rrn:v01"),
            &format!("tdek:{org}:rrn:v1:extra"),
        ] {
            assert!(matches!(TenantKekId::parse(bad), Err(CryptoError::Decrypt)));
        }
    }

    #[test]
    fn tenant_scoped_kms_isolates_tenants_scopes_and_shredded_state() {
        let master = test_master_kms();
        let org_a = Uuid::new_v4();
        let org_b = Uuid::new_v4();
        let tdek_a = Arc::new(SecretBox::new(Box::new([0x22u8; 32])));
        let tdek_b = Arc::new(SecretBox::new(Box::new([0x33u8; 32])));

        let mut map_a = BTreeMap::new();
        map_a.insert(1, tdek_a);
        let kms_a = TenantScopedKms::from_resolved(
            org_a,
            TenantKeyScope::Rrn,
            Some(1),
            false,
            map_a,
            Arc::clone(&master),
        );

        let mut map_b = BTreeMap::new();
        map_b.insert(1, tdek_b);
        let kms_b = TenantScopedKms::from_resolved(
            org_b,
            TenantKeyScope::Rrn,
            Some(1),
            false,
            map_b,
            Arc::clone(&master),
        );

        let org_a_str = org_a.to_string();
        let ctx = EnvelopeContext {
            tenant_id: &org_a_str,
            table: "employee_rrn",
            record: "employee_rrn",
            field: "rrn",
            purpose: "rrn_vault",
        };
        let sealed = seal_v3(&kms_a, ctx, b"9001011234567").unwrap();
        assert_eq!(
            sealed.header.alg_id,
            AlgId::AwsEsdkV2Aes256GcmHkdfSha256CommitKeyWrap
        );
        assert!(
            sealed
                .header
                .kek_id
                .as_str()
                .starts_with(&format!("tdek:{org_a}:rrn:v1"))
        );
        assert_eq!(
            open_v3(&kms_a, ctx, &sealed)
                .unwrap()
                .expose_secret()
                .as_slice(),
            b"9001011234567"
        );
        assert!(matches!(
            open_v3(&kms_b, ctx, &sealed),
            Err(CryptoError::Decrypt)
        ));

        let legacy_sealed = seal_v3(master.as_ref(), ctx, b"legacy").unwrap();
        assert_eq!(
            open_v3(&kms_a, ctx, &legacy_sealed)
                .unwrap()
                .expose_secret()
                .as_slice(),
            b"legacy"
        );

        let shredded_kms = TenantScopedKms::from_resolved(
            org_a,
            TenantKeyScope::Rrn,
            None,
            true,
            BTreeMap::new(),
            master,
        );
        assert!(matches!(
            open_v3(&shredded_kms, ctx, &sealed),
            Err(CryptoError::Decrypt)
        ));
        assert!(matches!(
            open_v3(&shredded_kms, ctx, &legacy_sealed),
            Err(CryptoError::Decrypt)
        ));
        let dummy = SecretBox::new(Box::new(*Zeroizing::new([0x44u8; 32])));
        assert!(matches!(
            shredded_kms.wrap_dek("rrn_vault", &dummy),
            Err(CryptoError::KeyNotFound)
        ));
    }
}
