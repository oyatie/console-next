use super::{CompiledBundleCacheKey, DualEngineMode};

/// Stubbed Cedar adapter result. Later code replaces construction of this enum
/// with real Cedar SDK evaluation; the boundary semantics stay stable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CedarEvaluation {
    NotConfigured,
    Allow {
        bundle_key: CompiledBundleCacheKey,
    },
    Deny {
        bundle_key: CompiledBundleCacheKey,
        reason: String,
    },
    Error {
        reason: String,
    },
}

/// Final authorization effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionEffect {
    Allow,
    Deny,
}

impl DecisionEffect {
    #[must_use]
    pub const fn is_allow(self) -> bool {
        matches!(self, Self::Allow)
    }
}

/// Engine path responsible for the decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionEngine {
    BoundaryPreflight,
    Legacy,
    Cedar,
    DualEngine,
}

/// Machine-readable deny/allow reason for audit and metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionReason {
    FeatureUnavailable,
    LegacyAllowed,
    LegacyDenied,
    CedarAllowed,
    CedarDenied,
    CedarError,
    MissingCoexistenceMap,
    MalformedCoexistenceMap,
    BundleUnavailable,
    StalePolicyBundle,
    MissingSubjectFreshness,
    StaleSubject,
    MissingRlsScopeProof,
    RlsBoundaryMismatch,
    EngineDisagreement,
}

/// Auditable decision emitted by the boundary.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationDecision {
    pub effect: DecisionEffect,
    pub engine: DecisionEngine,
    pub reason: DecisionReason,
    pub mode: Option<DualEngineMode>,
}

impl AuthorizationDecision {
    #[must_use]
    pub const fn allow(
        engine: DecisionEngine,
        reason: DecisionReason,
        mode: Option<DualEngineMode>,
    ) -> Self {
        Self {
            effect: DecisionEffect::Allow,
            engine,
            reason,
            mode,
        }
    }

    #[must_use]
    pub const fn deny(
        engine: DecisionEngine,
        reason: DecisionReason,
        mode: Option<DualEngineMode>,
    ) -> Self {
        Self {
            effect: DecisionEffect::Deny,
            engine,
            reason,
            mode,
        }
    }
}
