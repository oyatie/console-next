use super::{
    AuthorizationDecision, AuthorizationRequest, CedarEvaluation, CoexistenceMapEntry,
    DecisionEngine, DecisionReason, DualEngineMode,
};
use crate::{authorize, authorize_capability, authorize_org_wide, feature_available_in_v1};

/// Evaluate the existing authorization behavior through the new typed contract.
///
/// This is the compatibility adapter: with default freshness and same-org
/// resources it delegates to the current `authorize` / `authorize_capability` /
/// `authorize_org_wide` implementation, one arm per
/// [`AuthorizationResource`] constructor.
///
/// [`AuthorizationResource`]: super::AuthorizationResource
#[must_use]
pub fn evaluate_legacy_contract(request: &AuthorizationRequest) -> AuthorizationDecision {
    if let Some(decision) = preflight_denial(request, None) {
        return decision;
    }

    let result = match (request.resource.branch_id, request.resource.branchless) {
        (Some(branch_id), _) => authorize(&request.subject.principal, request.action, branch_id),
        (None, true) => authorize_capability(&request.subject.principal, request.action),
        // Every `AuthorizationResource::org_wide` caller keeps today's semantics.
        // Widening this arm to `authorize_capability` would drop the
        // `SUPER_ADMIN | EXECUTIVE` restriction for `ontology/rest`'s
        // `authority_effect` gate on `Feature::RoleManage`, among others.
        (None, false) => authorize_org_wide(&request.subject.principal, request.action),
    };

    match result {
        Ok(()) => AuthorizationDecision::allow(
            DecisionEngine::Legacy,
            DecisionReason::LegacyAllowed,
            Some(DualEngineMode::LegacyOnly),
        ),
        Err(_) => AuthorizationDecision::deny(
            DecisionEngine::Legacy,
            DecisionReason::LegacyDenied,
            Some(DualEngineMode::LegacyOnly),
        ),
    }
}

/// Evaluate an enrolled action through the explicit Cedar/PBAC coexistence map.
#[must_use]
pub fn evaluate_cedar_pbac_boundary(
    request: &AuthorizationRequest,
    map_entry: Option<&CoexistenceMapEntry>,
    cedar: CedarEvaluation,
) -> AuthorizationDecision {
    let Some(map_entry) = map_entry else {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::MissingCoexistenceMap,
            None,
        );
    };

    let mode = Some(map_entry.mode);
    if let Some(decision) = preflight_denial(request, mode) {
        return decision;
    }

    if !map_entry.matches_request(request) {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::MalformedCoexistenceMap,
            mode,
        );
    }

    if cedar_required(map_entry.mode)
        && let Some(decision) = cedar_precondition_denial(request, mode)
    {
        return decision;
    }

    if cedar_required(map_entry.mode) && map_entry.bundle_key.is_none() {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::BundleUnavailable,
            mode,
        );
    }

    match map_entry.mode {
        DualEngineMode::LegacyOnly => evaluate_legacy_contract(request),
        DualEngineMode::CedarShadowLegacyEnforce => {
            let cedar_shadow = cedar_decision(map_entry, &cedar, mode);
            if !cedar_shadow.effect.is_allow() {
                return cedar_shadow;
            }
            let legacy = evaluate_legacy_contract(request);
            if legacy.effect.is_allow() {
                AuthorizationDecision::allow(
                    DecisionEngine::DualEngine,
                    DecisionReason::LegacyAllowed,
                    mode,
                )
            } else {
                AuthorizationDecision::deny(
                    DecisionEngine::DualEngine,
                    DecisionReason::LegacyDenied,
                    mode,
                )
            }
        }
        DualEngineMode::CedarEnforceLegacyCompare => {
            let cedar_decision = cedar_decision(map_entry, &cedar, mode);
            if !cedar_decision.effect.is_allow() {
                return cedar_decision;
            }
            let legacy = evaluate_legacy_contract(request);
            if legacy.effect.is_allow() {
                AuthorizationDecision::allow(
                    DecisionEngine::DualEngine,
                    DecisionReason::CedarAllowed,
                    mode,
                )
            } else {
                AuthorizationDecision::deny(
                    DecisionEngine::DualEngine,
                    DecisionReason::EngineDisagreement,
                    mode,
                )
            }
        }
        DualEngineMode::CedarOnly => cedar_decision(map_entry, &cedar, mode),
    }
}

fn cedar_precondition_denial(
    request: &AuthorizationRequest,
    mode: Option<DualEngineMode>,
) -> Option<AuthorizationDecision> {
    if !request.subject.freshness.has_subject_material()
        || !request.required_freshness.requires_subject_material()
    {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::MissingSubjectFreshness,
            mode,
        ));
    }

    let Some(proof) = request.rls_scope_proof else {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::MissingRlsScopeProof,
            mode,
        ));
    };

    if proof.org_id != request.subject.principal.org_id || proof.org_id != request.resource.org_id {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::RlsBoundaryMismatch,
            mode,
        ));
    }

    None
}

fn preflight_denial(
    request: &AuthorizationRequest,
    mode: Option<DualEngineMode>,
) -> Option<AuthorizationDecision> {
    if !feature_available_in_v1(request.action.feature()) {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::FeatureUnavailable,
            mode,
        ));
    }
    if request.subject.principal.org_id != request.resource.org_id {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::RlsBoundaryMismatch,
            mode,
        ));
    }

    if !request
        .subject
        .freshness
        .satisfies(request.required_freshness)
    {
        return Some(AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::StaleSubject,
            mode,
        ));
    }

    None
}

/// Whether `mode` arms the Cedar-side fail-closed guards in
/// [`evaluate_cedar_pbac_boundary`]: the subject-freshness / RLS-scope-proof
/// preconditions and the bundle-availability denial.
///
/// Membership is positive and closed: only the modes named here are guarded,
/// and the const block below makes that list total over [`DualEngineMode`].
pub(super) const fn cedar_required(mode: DualEngineMode) -> bool {
    matches!(
        mode,
        DualEngineMode::CedarShadowLegacyEnforce
            | DualEngineMode::CedarEnforceLegacyCompare
            | DualEngineMode::CedarOnly
    )
}

/// Exhaustiveness anchor for [`cedar_required`], checked at compile time.
///
/// `matches!` is not exhaustiveness-checked, so on its own a new
/// [`DualEngineMode`] would compile clean and fall out of every Cedar-side
/// fail-closed guard. `posture` below is a real `match`: adding a variant is a
/// compile error until its guard posture is stated, and stating a posture that
/// disagrees with `cedar_required` fails const evaluation.
const _: () = {
    const fn posture(mode: DualEngineMode) -> bool {
        match mode {
            DualEngineMode::LegacyOnly => false,
            DualEngineMode::CedarShadowLegacyEnforce
            | DualEngineMode::CedarEnforceLegacyCompare
            | DualEngineMode::CedarOnly => true,
        }
    }

    let mut i = 0;
    while i < DualEngineMode::ALL.len() {
        let mode = DualEngineMode::ALL[i];
        assert!(posture(mode) == cedar_required(mode));
        i += 1;
    }
};

fn cedar_matches_map(map_entry: &CoexistenceMapEntry, cedar: &CedarEvaluation) -> bool {
    match (map_entry.bundle_key.as_ref(), cedar) {
        (Some(expected), CedarEvaluation::Allow { bundle_key })
        | (Some(expected), CedarEvaluation::Deny { bundle_key, .. }) => expected == bundle_key,
        (_, CedarEvaluation::Error { .. }) => true,
        (_, CedarEvaluation::NotConfigured) => false,
        (None, _) => false,
    }
}

fn cedar_decision(
    map_entry: &CoexistenceMapEntry,
    cedar: &CedarEvaluation,
    mode: Option<DualEngineMode>,
) -> AuthorizationDecision {
    if matches!(cedar, CedarEvaluation::NotConfigured) {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::BundleUnavailable,
            mode,
        );
    }

    if !cedar_matches_map(map_entry, cedar) {
        return AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::StalePolicyBundle,
            mode,
        );
    }

    match cedar {
        CedarEvaluation::Allow { .. } => {
            AuthorizationDecision::allow(DecisionEngine::Cedar, DecisionReason::CedarAllowed, mode)
        }
        CedarEvaluation::Deny { .. } => {
            AuthorizationDecision::deny(DecisionEngine::Cedar, DecisionReason::CedarDenied, mode)
        }
        CedarEvaluation::Error { .. } => {
            AuthorizationDecision::deny(DecisionEngine::Cedar, DecisionReason::CedarError, mode)
        }
        CedarEvaluation::NotConfigured => AuthorizationDecision::deny(
            DecisionEngine::BoundaryPreflight,
            DecisionReason::BundleUnavailable,
            mode,
        ),
    }
}
