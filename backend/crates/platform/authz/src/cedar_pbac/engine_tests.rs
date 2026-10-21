#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use console_kernel_core::{BranchScope, OrgId, UserId};

use super::{
    ROLE_MANAGE_SCHEMA, ROLE_MANAGE_SCHEMA_VERSION, compile_bundle, compile_bundle_for_feature,
    compile_bundle_from_sources, evaluate, generate_policies,
};
use crate::{
    Action, AuthorizationRequest, AuthorizationResource, CedarEvaluation, Feature, Principal, Role,
};

fn role_manage_request(role: Role) -> AuthorizationRequest {
    let principal = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([role]),
        BranchScope::All,
    );
    AuthorizationRequest::new(
        principal,
        Action::new(Feature::RoleManage),
        AuthorizationResource::org_wide(OrgId::one(), "role"),
    )
}

fn resource_kind_for(feature: Feature) -> &'static str {
    match feature {
        Feature::UserManage => "user",
        Feature::CompletionReview | Feature::ApprovalFinalize => "workflow_run",
        _ => "work_order",
    }
}

fn feature_request(feature: Feature, role: Role) -> AuthorizationRequest {
    let principal = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([role]),
        BranchScope::All,
    );
    AuthorizationRequest::new(
        principal,
        Action::new(feature),
        AuthorizationResource::org_wide(OrgId::one(), resource_kind_for(feature)),
    )
}

/// The enrollment-wave-2 generalization: a per-feature bundle compiles under
/// strict validation and its Cedar verdict matches the legacy matrix for the
/// enrolled feature (allow the matrix-allowed role, deny the denied one) — the
/// property parity measurement depends on.
#[test]
fn per_feature_bundle_matches_the_legacy_matrix() {
    for feature in [
        Feature::WorkOrderReadAll,
        Feature::UserManage,
        Feature::CompletionReview,
        Feature::ApprovalFinalize,
    ] {
        let bundle = compile_bundle_for_feature(OrgId::one(), 1, feature)
            .expect("per-feature bundle must compile + strict-validate");

        // SUPER_ADMIN is Allow for every enrolled feature above.
        let allow = evaluate(&feature_request(feature, Role::SuperAdmin), &bundle);
        assert!(
            matches!(allow, CedarEvaluation::Allow { .. }),
            "{feature:?}: SUPER_ADMIN must be allowed, got {allow:?}"
        );

        // MEMBER (bottom of the matrix) is Deny for every one of them.
        let deny = evaluate(&feature_request(feature, Role::Member), &bundle);
        assert!(
            matches!(deny, CedarEvaluation::Deny { .. }),
            "{feature:?}: MEMBER must be denied, got {deny:?}"
        );
    }
}

#[test]
fn per_feature_bundle_keys_differ_across_features() {
    let a = compile_bundle_for_feature(OrgId::one(), 1, Feature::WorkOrderReadAll).unwrap();
    let b = compile_bundle_for_feature(OrgId::one(), 1, Feature::UserManage).unwrap();
    assert_ne!(
        a.key, b.key,
        "distinct features must produce distinct bundle identities"
    );
}

#[test]
fn matrix_generated_role_manage_policy_is_single_super_admin_rule() {
    let policies = generate_policies(Feature::RoleManage);
    assert_eq!(
        policies.matches("permit(").count(),
        1,
        "RoleManage must generate exactly one permit rule: {policies}"
    );
    assert!(
        policies.contains("principal.roles.contains(\"SUPER_ADMIN\")"),
        "the single rule must gate on SUPER_ADMIN: {policies}"
    );
    for role in [
        Role::Member,
        Role::Receptionist,
        Role::Mechanic,
        Role::Admin,
        Role::Executive,
    ] {
        assert!(
            !policies.contains(&format!("contains(\"{}\")", role.as_str())),
            "non-SUPER_ADMIN role {} must not appear in RoleManage policy",
            role.as_str()
        );
    }
}

#[test]
fn matrix_generated_bundle_compiles_and_passes_strict_validation() {
    let bundle = compile_bundle(OrgId::one(), 7).expect("bundle must compile + strict-validate");
    assert_eq!(bundle.key.org_id, OrgId::one());
    assert_eq!(bundle.key.policy_version, 7);
    assert_eq!(bundle.key.schema_version, ROLE_MANAGE_SCHEMA_VERSION);
    assert_eq!(bundle.key.cedar_sdk_version, "4.11.2");
    assert_eq!(bundle.key.cedar_language_version, "4.5");
    assert!(!bundle.key.bundle_digest.is_empty());
}

#[test]
fn invalid_policy_fails_strict_validation_and_is_not_activated() {
    // Real schema, but a policy that reads an attribute the schema does not
    // declare on Subject — strict validation must reject it fail-closed.
    let bad_policy = "permit(\n  principal,\n  action == Action::\"role_manage\",\n  resource\n)\nwhen { principal.nonexistent_attr == \"x\" };\n";
    let result = compile_bundle_from_sources(
        OrgId::one(),
        1,
        ROLE_MANAGE_SCHEMA_VERSION,
        ROLE_MANAGE_SCHEMA,
        bad_policy,
    );
    assert!(
        result.is_err(),
        "a policy referencing an undeclared attribute must fail strict validation"
    );
}

#[test]
fn invalid_schema_is_not_activated() {
    // A schema whose action references an undeclared entity type must not
    // compile into an activated bundle.
    let bad_schema = "entity Subject = { \"org\": String };\naction role_manage appliesTo {\n  principal: [Subject],\n  resource: [DoesNotExist]\n};\n";
    let result = compile_bundle_from_sources(
        OrgId::one(),
        1,
        ROLE_MANAGE_SCHEMA_VERSION,
        bad_schema,
        &generate_policies(Feature::RoleManage),
    );
    assert!(
        result.is_err(),
        "a schema referencing an undeclared entity type must fail closed"
    );
}

#[test]
fn evaluate_allows_super_admin_and_denies_others() {
    let bundle = compile_bundle(OrgId::one(), 1).unwrap();

    let allow = evaluate(&role_manage_request(Role::SuperAdmin), &bundle);
    match allow {
        CedarEvaluation::Allow { bundle_key } => {
            assert_eq!(
                bundle_key, bundle.key,
                "allow must carry the bundle's own compiled key"
            );
        }
        other => panic!("SUPER_ADMIN must be allowed role_manage, got {other:?}"),
    }

    for role in [
        Role::Member,
        Role::Receptionist,
        Role::Mechanic,
        Role::Admin,
        Role::Executive,
    ] {
        let denied = evaluate(&role_manage_request(role), &bundle);
        assert!(
            matches!(denied, CedarEvaluation::Deny { .. }),
            "{} must be denied role_manage, got {denied:?}",
            role.as_str()
        );
    }
}

#[test]
fn bundle_digest_is_deterministic_across_compiles() {
    let first = compile_bundle(OrgId::one(), 1).unwrap();
    let second = compile_bundle(OrgId::one(), 1).unwrap();
    assert_eq!(
        first.key.bundle_digest, second.key.bundle_digest,
        "same schema + policy inputs must yield an identical digest"
    );

    // A different policy_version keeps the same digest (same inputs) but is a
    // distinct cache key so a version bump re-keys the bundle.
    let bumped = compile_bundle(OrgId::one(), 2).unwrap();
    assert_eq!(first.key.bundle_digest, bumped.key.bundle_digest);
    assert_ne!(first.key, bumped.key);
}
