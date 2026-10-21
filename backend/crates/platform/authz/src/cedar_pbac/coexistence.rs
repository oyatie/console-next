use console_kernel_core::{KernelError, OrgId};

use super::{AuthorizationRequest, Feature, FromStr};

/// Immutable identity for compiled Cedar bundle material.
///
/// This is the only v1 cache key shape. It identifies parsed/validated bundle
/// material, not an allow/deny decision.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub struct CompiledBundleCacheKey {
    pub org_id: OrgId,
    pub policy_version: u64,
    pub schema_version: String,
    pub bundle_digest: String,
    pub cedar_sdk_version: String,
    pub cedar_language_version: String,
}

impl CompiledBundleCacheKey {
    pub fn new(
        org_id: OrgId,
        policy_version: u64,
        schema_version: impl Into<String>,
        bundle_digest: impl Into<String>,
        cedar_sdk_version: impl Into<String>,
        cedar_language_version: impl Into<String>,
    ) -> Result<Self, KernelError> {
        let key = Self {
            org_id,
            policy_version,
            schema_version: non_empty("schema_version", schema_version.into())?,
            bundle_digest: non_empty("bundle_digest", bundle_digest.into())?,
            cedar_sdk_version: non_empty("cedar_sdk_version", cedar_sdk_version.into())?,
            cedar_language_version: non_empty(
                "cedar_language_version",
                cedar_language_version.into(),
            )?,
        };
        Ok(key)
    }
}

/// Declares [`DualEngineMode`] and [`DualEngineMode::ALL`] from one token list,
/// so the roster cannot go stale: a variant can only be added inside the
/// invocation below, which extends `ALL` in the same edit.
macro_rules! dual_engine_modes {
    ($($variant:ident),+ $(,)?) => {
        /// Explicit dual-engine migration mode from the coexistence map.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum DualEngineMode {
            $($variant,)+
        }

        impl DualEngineMode {
            /// Every mode. The exhaustive source guards and audits enumerate.
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];
        }
    };
}

dual_engine_modes!(
    LegacyOnly,
    CedarShadowLegacyEnforce,
    CedarEnforceLegacyCompare,
    CedarOnly,
);

impl FromStr for DualEngineMode {
    type Err = KernelError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "legacy_only" => Ok(Self::LegacyOnly),
            "cedar_shadow_legacy_enforce" => Ok(Self::CedarShadowLegacyEnforce),
            "cedar_enforce_legacy_compare" => Ok(Self::CedarEnforceLegacyCompare),
            "cedar_only" => Ok(Self::CedarOnly),
            _ => Err(KernelError::validation(format!(
                "unsupported Cedar/PBAC dual-engine mode: {raw}"
            ))),
        }
    }
}

/// One explicit coexistence-map entry for an enrolled action/domain.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoexistenceMapEntry {
    pub id: String,
    pub domain: String,
    pub feature: Feature,
    pub resource_type: String,
    pub mode: DualEngineMode,
    pub bundle_key: Option<CompiledBundleCacheKey>,
}

impl CoexistenceMapEntry {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        domain: impl Into<String>,
        feature: Feature,
        resource_type: impl Into<String>,
        mode: DualEngineMode,
        bundle_key: Option<CompiledBundleCacheKey>,
    ) -> Self {
        Self {
            id: id.into(),
            domain: domain.into(),
            feature,
            resource_type: resource_type.into(),
            mode,
            bundle_key,
        }
    }

    #[must_use]
    pub fn matches_request(&self, request: &AuthorizationRequest) -> bool {
        !self.domain.trim().is_empty()
            && !request.domain.trim().is_empty()
            && self.domain == request.domain
            && self.feature == request.action.feature()
            && self.resource_type == request.resource.resource_type
    }
}

fn non_empty(field: &str, value: String) -> Result<String, KernelError> {
    if value.trim().is_empty() {
        Err(KernelError::validation(format!(
            "compiled Cedar bundle cache key missing {field}"
        )))
    } else {
        Ok(value)
    }
}
