#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-28 (decisions D0.1 §3): Cedar fails closed through the public boundary.
//!
//! A Cedar-only SoD action with a missing fact, a mistyped fact, an undeclared
//! fact or an erroring `forbid` must end as a Deny at
//! `evaluate_cedar_pbac_boundary`, never as an Allow. The per-action schema and
//! policy here are test-local; real actions register in `cedar_pbac::actions`.

use std::collections::BTreeSet;

use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::cedar_pbac::action_schema::{ActionSchema, FactType, RequiredFact};
use console_platform_authz::cedar_pbac::engine::CompiledBundle;
use console_platform_authz::cedar_pbac::facts::second_person::SECOND_PERSON_BLOCK;
use console_platform_authz::cedar_pbac::facts::{Facts, evaluate_with_facts};
use console_platform_authz::{
    Action, AuthorizationRequest, AuthorizationResource, CedarEvaluation, CoexistenceMapEntry,
    DecisionEffect, DualEngineMode, Feature, Principal, RlsScopeProof, Role, SubjectFreshness,
    SubjectFreshnessRequirement, evaluate_cedar_pbac_boundary,
};

const FACTS: &[RequiredFact] = &[
    RequiredFact {
        name: "other_eligible_holders",
        ty: FactType::Long,
    },
    RequiredFact {
        name: "step_up",
        ty: FactType::Bool,
    },
];

/// The D0.2 sole-holder shape: a second person is required whenever one exists.
const SOD: ActionSchema = ActionSchema {
    feature: Feature::RoleManage,
    version: "test-fail-closed-v1",
    facts: FACTS,
    policies: "permit(principal, action == Action::\"role_manage\", resource)\nwhen { principal.roles.contains(\"SUPER_ADMIN\") && context.step_up };\nforbid(principal, action == Action::\"role_manage\", resource)\nwhen { context.other_eligible_holders > 0 };\n",
};

fn bundle(policies: &str) -> CompiledBundle {
    SOD.compile(OrgId::one(), 7, policies)
        .expect("test bundle must strict-validate")
}

fn request() -> AuthorizationRequest {
    let principal = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    AuthorizationRequest::new(
        principal,
        Action::new(Feature::RoleManage),
        AuthorizationResource::org_wide(OrgId::one(), "role"),
    )
    .with_policy_domain("identity.policy")
    .with_subject_freshness(SubjectFreshness {
        policy_version: 7,
        subject_version: 1,
        session_generation: 1,
        step_up_generation: None,
    })
    .requiring_freshness(SubjectFreshnessRequirement {
        min_policy_version: 7,
        min_subject_version: 1,
        min_session_generation: 1,
        required_step_up_generation: None,
    })
    .with_rls_scope_proof(RlsScopeProof::runtime_role_guc(OrgId::one()))
}

fn decide(bundle: &CompiledBundle, facts: &Facts) -> (CedarEvaluation, DecisionEffect) {
    let request = request();
    let entry = CoexistenceMapEntry::new(
        "identity.policy.role_manage",
        "identity.policy",
        Feature::RoleManage,
        "role",
        DualEngineMode::CedarOnly,
        Some(bundle.key.clone()),
    );
    let cedar = evaluate_with_facts(&request, bundle, facts);
    let decision = evaluate_cedar_pbac_boundary(&request, Some(&entry), cedar.clone());
    (cedar, decision.effect)
}

fn sole_holder() -> Facts {
    Facts::new()
        .long("other_eligible_holders", 0)
        .bool("step_up", true)
}

#[test]
fn complete_facts_allow_only_the_sole_holder_with_step_up() {
    let bundle = bundle(SOD.policies);
    let (_, effect) = decide(&bundle, &sole_holder());
    assert_eq!(effect, DecisionEffect::Allow);
    let other = sole_holder().long("other_eligible_holders", 1);
    assert_eq!(decide(&bundle, &other).1, DecisionEffect::Deny);
}

#[test]
fn cedar_fail_closed_missing_or_bad_fact_denies() {
    let bundle = bundle(SOD.policies);
    let missing = Facts::new().bool("step_up", true);
    let mistyped = sole_holder().string("other_eligible_holders", "0");
    let extra = sole_holder().bool("client_says_ok", true);
    let envelope = sole_holder().string("channel", "web");
    for facts in [Facts::new(), missing, mistyped, extra, envelope] {
        let (cedar, effect) = decide(&bundle, &facts);
        assert!(
            matches!(cedar, CedarEvaluation::Error { .. }),
            "{facts:?}: {cedar:?}"
        );
        assert_eq!(effect, DecisionEffect::Deny, "{facts:?}");
    }
}

#[test]
fn cedar_fail_closed_erroring_forbid_denies() {
    // Strict validation cannot see i64 overflow. At runtime the forbid errors
    // and Cedar skips it; before BW-28 the permit then produced Allow.
    let policies = format!(
        "{}forbid(principal, action == Action::\"role_manage\", resource)\nwhen {{ context.other_eligible_holders + 9223372036854775807 > 0 }};\n",
        "permit(principal, action == Action::\"role_manage\", resource)\nwhen { context.step_up };\n"
    );
    let (cedar, effect) = decide(
        &bundle(&policies),
        &sole_holder().long("other_eligible_holders", 1),
    );
    assert!(matches!(cedar, CedarEvaluation::Error { .. }), "{cedar:?}");
    assert_eq!(effect, DecisionEffect::Deny);
}

/// The decisions #7 sole-holder shape over the shared BW-29 block: a second
/// person must decide whenever one exists, and `refuse` mode never falls back.
const SOLE_HOLDER: ActionSchema = ActionSchema {
    feature: Feature::RoleManage,
    version: "test-sole-holder-v1",
    facts: &SECOND_PERSON_BLOCK,
    policies: "forbid(principal, action == Action::\"role_manage\", resource)\nwhen { context.other_eligible_holders > 0 || context.sole_holder_mode == \"refuse\" };\npermit(principal, action == Action::\"role_manage\", resource)\nwhen { context.actor_holds_permission && context.step_up && context.other_eligible_holders == 0 };\n",
};

fn sole_holder_block() -> Facts {
    Facts::new()
        .long("other_eligible_holders", 0)
        .bool("step_up", true)
        .bool("actor_is_requester", true)
        .bool("actor_contributed", false)
        .bool("actor_holds_permission", true)
        .string("sole_holder_mode", "step_up_notice_review")
}

#[test]
fn the_shared_second_person_block_gates_the_sole_holder_fallback() {
    let bundle = SOLE_HOLDER
        .compile(OrgId::one(), 7, SOLE_HOLDER.policies)
        .expect("the shared block must strict-validate");
    assert_eq!(
        decide(&bundle, &sole_holder_block()).1,
        DecisionEffect::Allow
    );
    for facts in [
        sole_holder_block().long("other_eligible_holders", 1),
        sole_holder_block().string("sole_holder_mode", "refuse"),
        sole_holder_block().bool("step_up", false),
    ] {
        assert_eq!(decide(&bundle, &facts).1, DecisionEffect::Deny, "{facts:?}");
    }
    for fact in SECOND_PERSON_BLOCK {
        let mut missing = Facts::new();
        for other in SECOND_PERSON_BLOCK.iter().filter(|f| f.name != fact.name) {
            missing = missing.with(
                other.name,
                sole_holder_block().get(other.name).unwrap().clone(),
            );
        }
        let (cedar, effect) = decide(&bundle, &missing);
        assert!(
            matches!(cedar, CedarEvaluation::Error { .. }),
            "{}: {cedar:?}",
            fact.name
        );
        assert_eq!(effect, DecisionEffect::Deny, "{}", fact.name);
    }
}
