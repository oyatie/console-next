//! The four fail-closed conditions of [`evaluate_cedar_pbac_boundary`].

use super::*;

// ---------------------------------------------------------------------------
// The four fail-closed conditions. Each case uses a LEGACY-ALLOWING principal
// and a Cedar ALLOW, so the only way the assertion can fail is the boundary
// permitting through the fault.
// ---------------------------------------------------------------------------

/// The single seam a "make the shadow lane purely observational" refactor would
/// touch first: [`super::cedar_required`] is what arms the Cedar-side
/// precondition and bundle-availability denials in
/// [`evaluate_cedar_pbac_boundary`]. Pinning the classifier directly means the
/// guarantee is checkable by reading and running, without mutating the source.
///
/// Stated as an equivalence over [`DualEngineMode::ALL`], not over a
/// hand-listed subset, so it can detect its own violation: a mode added to the
/// enum lands in `ALL` automatically, and the only posture that keeps this test
/// green is "Cedar-requiring", i.e. fully guarded. Declaring a new mode exempt
/// turns this RED instead of silently dropping all four guards.
#[test]
fn legacy_only_is_the_only_mode_exempt_from_the_fail_closed_guards() {
    for mode in DualEngineMode::ALL.iter().copied() {
        assert_eq!(
            super::cedar_required(mode),
            mode != DualEngineMode::LegacyOnly,
            "{mode:?}"
        );
    }
}

#[test]
fn every_cedar_mode_denies_an_invalid_enrollment_map() {
    // No map entry at all for an enrolled request.
    let missing =
        evaluate_cedar_pbac_boundary(&ready_request(Role::SuperAdmin), None, cedar_allow());
    assert_eq!(missing.effect, DecisionEffect::Deny);
    assert_eq!(missing.reason, DecisionReason::MissingCoexistenceMap);
    assert_eq!(missing.engine, DecisionEngine::BoundaryPreflight);

    for mode in cedar_modes() {
        // Entry present but bound to another action / domain / resource type.
        let mismatches = [
            CoexistenceMapEntry::new(
                format!("{DOMAIN}.user_manage"),
                DOMAIN,
                Feature::UserManage,
                RESOURCE_TYPE,
                mode,
                Some(bundle_key()),
            ),
            CoexistenceMapEntry::new(
                format!("{DOMAIN}.role_manage"),
                "workflow.guards",
                Feature::RoleManage,
                RESOURCE_TYPE,
                mode,
                Some(bundle_key()),
            ),
            CoexistenceMapEntry::new(
                format!("{DOMAIN}.role_manage"),
                DOMAIN,
                Feature::RoleManage,
                "work_order",
                mode,
                Some(bundle_key()),
            ),
        ];
        for mismatch in mismatches {
            let decision = evaluate_cedar_pbac_boundary(
                &ready_request(Role::SuperAdmin),
                Some(&mismatch),
                cedar_allow(),
            );
            assert_eq!(decision.effect, DecisionEffect::Deny, "{mode:?}");
            assert_eq!(
                decision.reason,
                DecisionReason::MalformedCoexistenceMap,
                "{mode:?}"
            );
            assert_eq!(decision.mode, Some(mode));
        }
    }
}

#[test]
fn every_cedar_mode_denies_a_stale_identity() {
    for mode in cedar_modes() {
        // Token snapshot below the DB-current requirement.
        let stale =
            ready_request(Role::SuperAdmin).requiring_freshness(SubjectFreshnessRequirement {
                min_policy_version: 8,
                ..required_freshness()
            });
        let decision = evaluate_cedar_pbac_boundary(&stale, Some(&entry(mode)), cedar_allow());
        assert_eq!(decision.effect, DecisionEffect::Deny, "{mode:?}");
        assert_eq!(decision.reason, DecisionReason::StaleSubject, "{mode:?}");
        assert_eq!(decision.mode, Some(mode));

        // No subject material at all is equally fatal for a Cedar-requiring mode.
        let bare = AuthorizationRequest::new(
            principal(Role::SuperAdmin),
            Action::new(Feature::RoleManage),
            AuthorizationResource::org_wide(OrgId::one(), RESOURCE_TYPE),
        )
        .with_policy_domain(DOMAIN)
        .with_rls_scope_proof(RlsScopeProof::runtime_role_guc(OrgId::one()));
        let decision = evaluate_cedar_pbac_boundary(&bare, Some(&entry(mode)), cedar_allow());
        assert_eq!(decision.effect, DecisionEffect::Deny, "{mode:?}");
        assert_eq!(
            decision.reason,
            DecisionReason::MissingSubjectFreshness,
            "{mode:?}"
        );
    }
}

#[test]
fn every_cedar_mode_denies_an_rls_mismatch() {
    for mode in cedar_modes() {
        // Principal org != resource org.
        let cross_org = AuthorizationRequest::new(
            principal(Role::SuperAdmin),
            Action::new(Feature::RoleManage),
            AuthorizationResource::org_wide(OrgId::platform(), RESOURCE_TYPE),
        )
        .with_policy_domain(DOMAIN)
        .with_subject_freshness(freshness())
        .requiring_freshness(required_freshness())
        .with_rls_scope_proof(RlsScopeProof::runtime_role_guc(OrgId::one()));
        let decision = evaluate_cedar_pbac_boundary(&cross_org, Some(&entry(mode)), cedar_allow());
        assert_eq!(decision.effect, DecisionEffect::Deny, "{mode:?}");
        assert_eq!(
            decision.reason,
            DecisionReason::RlsBoundaryMismatch,
            "{mode:?}"
        );

        // Armed RLS scope belongs to a different tenant than the request.
        let wrong_proof = ready_request(Role::SuperAdmin)
            .with_rls_scope_proof(RlsScopeProof::runtime_role_guc(OrgId::platform()));
        let decision =
            evaluate_cedar_pbac_boundary(&wrong_proof, Some(&entry(mode)), cedar_allow());
        assert_eq!(decision.effect, DecisionEffect::Deny, "{mode:?}");
        assert_eq!(
            decision.reason,
            DecisionReason::RlsBoundaryMismatch,
            "{mode:?}"
        );

        // No proof that the DB reads ran under an armed scope at all.
        let no_proof = AuthorizationRequest::new(
            principal(Role::SuperAdmin),
            Action::new(Feature::RoleManage),
            AuthorizationResource::org_wide(OrgId::one(), RESOURCE_TYPE),
        )
        .with_policy_domain(DOMAIN)
        .with_subject_freshness(freshness())
        .requiring_freshness(required_freshness());
        let decision = evaluate_cedar_pbac_boundary(&no_proof, Some(&entry(mode)), cedar_allow());
        assert_eq!(decision.effect, DecisionEffect::Deny, "{mode:?}");
        assert_eq!(
            decision.reason,
            DecisionReason::MissingRlsScopeProof,
            "{mode:?}"
        );
    }
}

#[test]
fn every_cedar_mode_denies_an_unavailable_bundle() {
    for mode in cedar_modes() {
        // The map entry carries no compiled bundle identity.
        let unbound = CoexistenceMapEntry::new(
            format!("{DOMAIN}.role_manage"),
            DOMAIN,
            Feature::RoleManage,
            RESOURCE_TYPE,
            mode,
            None,
        );
        let decision = evaluate_cedar_pbac_boundary(
            &ready_request(Role::SuperAdmin),
            Some(&unbound),
            cedar_allow(),
        );
        assert_eq!(decision.effect, DecisionEffect::Deny, "{mode:?}");
        assert_eq!(
            decision.reason,
            DecisionReason::BundleUnavailable,
            "{mode:?}"
        );
        assert_eq!(decision.mode, Some(mode));

        // No Cedar adapter was configured to evaluate against the bundle.
        let decision = evaluate_cedar_pbac_boundary(
            &ready_request(Role::SuperAdmin),
            Some(&entry(mode)),
            CedarEvaluation::NotConfigured,
        );
        assert_eq!(decision.effect, DecisionEffect::Deny, "{mode:?}");
        assert_eq!(
            decision.reason,
            DecisionReason::BundleUnavailable,
            "{mode:?}"
        );

        // Cedar answered from a bundle that is not the enrolled one.
        let decision = evaluate_cedar_pbac_boundary(
            &ready_request(Role::SuperAdmin),
            Some(&entry(mode)),
            CedarEvaluation::Allow {
                bundle_key: stale_bundle_key(),
            },
        );
        assert_eq!(decision.effect, DecisionEffect::Deny, "{mode:?}");
        assert_eq!(
            decision.reason,
            DecisionReason::StalePolicyBundle,
            "{mode:?}"
        );
    }
}
