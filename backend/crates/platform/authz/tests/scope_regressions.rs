// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_platform_authz::access::NodeKind;
use console_platform_authz::cedar_pbac::actions::{exception_decide, settings_manage};
use console_platform_authz::cedar_pbac::facts::scope::granted_scope;
use uuid::Uuid;

#[test]
fn granted_scope_keeps_entity_and_workplace_but_never_widens_department() {
    let (entity, workplace, department) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    assert_eq!(granted_scope([]), Some(vec![]));
    assert_eq!(
        granted_scope([
            (NodeKind::LegalEntity, entity),
            (NodeKind::Workplace, workplace),
            (NodeKind::Department, department),
        ]),
        Some(vec![entity, workplace])
    );
    assert_eq!(
        granted_scope([
            (NodeKind::LegalEntity, entity),
            (NodeKind::Tenant, Uuid::nil())
        ]),
        None
    );
}

#[test]
fn only_the_actions_declared_public_denials_can_be_exposed() {
    let settings = settings_manage::SCHEMA;
    for code in ["out_of_scope", "scope_tenant_wide_only", "step_up_required"] {
        assert_eq!(settings.denial_code(code), Some(code));
    }
    for code in [
        "internal",
        "out_of_scope,step_up_required",
        "",
        "authz_sod_requester",
    ] {
        assert_eq!(settings.denial_code(code), None);
    }
    assert_eq!(
        exception_decide::SCHEMA.denial_code("authz_sod_requester"),
        None
    );
    let another_action = console_platform_authz::cedar_pbac::action_schema::ActionSchema {
        denial_codes: &["authz_sod_requester"],
        ..exception_decide::SCHEMA
    };
    assert_eq!(
        another_action.denial_code("authz_sod_requester"),
        Some("authz_sod_requester")
    );
}

#[test]
fn other_actions_keep_annotation_in_audit_without_exposing_it() {
    use console_kernel_core::{BranchScope, OrgId, UserId};
    use console_platform_authz::cedar_pbac::action_schema::compile_action_bundle;
    use console_platform_authz::cedar_pbac::enforce::enforce_action;
    use console_platform_authz::cedar_pbac::facts::{Facts, evaluate_with_facts};
    use console_platform_authz::{
        Action, AuthorizationDecision, AuthorizationRequest, AuthorizationResource, DecisionEngine,
        DecisionReason, Feature, Principal, observe_cedar_pbac_decision,
    };
    let org = OrgId::new();
    let principal = Principal::new(UserId::new(), org, Default::default(), BranchScope::All);
    let facts = Facts::new()
        .bool("actor_is_requester", true)
        .bool("actor_contributed", false)
        .bool("actor_holds_permission", true)
        .bool("step_up", true)
        .bool("is_approval", true);
    let resource = AuthorizationResource::org_wide(org, "exception");
    let feature = Feature::ExceptionDecide;
    let bundle =
        compile_action_bundle(org, principal.authz_freshness.policy_version, feature).unwrap();
    let request =
        AuthorizationRequest::new(principal.clone(), Action::new(feature), resource.clone());
    let evaluation = evaluate_with_facts(&request, &bundle, &facts);
    let audit = observe_cedar_pbac_decision(
        &request,
        None,
        Some(&evaluation),
        AuthorizationDecision::deny(DecisionEngine::Cedar, DecisionReason::CedarDenied, None),
    );
    assert_eq!(
        audit.evaluated_reason_detail.as_deref(),
        Some("authz_sod_requester")
    );
    assert_eq!(
        enforce_action(&principal, feature, resource, &facts)
            .unwrap_err()
            .code,
        None
    );
}
