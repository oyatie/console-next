#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-06 Cedar (decisions #5, #7): `exception_decide` through the live
//! `enforce_action` call. The requester and a contributor never decide; a
//! holder approves only with step-up and declines without it; a missing or
//! undeclared fact, another tenant's exception, or an unenrolled action denies.

use std::collections::BTreeSet;

use console_kernel_core::{BranchScope, ErrorKind, OrgId, UserId};
use console_platform_authz::cedar_pbac::enforce::enforce_action;
use console_platform_authz::cedar_pbac::facts::Facts;
use console_platform_authz::{AuthorizationResource, Feature, Principal, Role};

fn decide(feature: Feature, resource_org: OrgId, facts: &Facts) -> bool {
    let principal = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::Admin]),
        BranchScope::All,
    );
    let resource = AuthorizationResource::org_wide(resource_org, "governed_exception");
    match enforce_action(&principal, feature, resource, facts) {
        Ok(()) => true,
        Err(err) => {
            assert_eq!(err.kind, ErrorKind::Forbidden, "{err:?}");
            false
        }
    }
}

fn exception(facts: &Facts) -> bool {
    decide(Feature::ExceptionDecide, OrgId::one(), facts)
}

/// An eligible second person approving with step-up.
fn holder() -> Facts {
    Facts::new()
        .bool("actor_is_requester", false)
        .bool("actor_contributed", false)
        .bool("actor_holds_permission", true)
        .bool("step_up", true)
        .bool("is_approval", true)
}

#[test]
fn a_holder_approves_with_step_up_and_declines_without() {
    assert!(exception(&holder()));
    assert!(exception(
        &holder().bool("step_up", false).bool("is_approval", false)
    ));
    assert!(!exception(&holder().bool("step_up", false)));
}

#[test]
fn the_requester_or_a_contributor_never_decides() {
    for sod in ["actor_is_requester", "actor_contributed"] {
        assert!(!exception(&holder().bool(sod, true)), "{sod}");
        assert!(
            !exception(&holder().bool(sod, true).bool("is_approval", false)),
            "{sod} decline"
        );
    }
}

#[test]
fn a_non_holder_or_another_tenant_is_denied() {
    assert!(!exception(&holder().bool("actor_holds_permission", false)));
    assert!(!decide(Feature::ExceptionDecide, OrgId::new(), &holder()));
}

#[test]
fn a_missing_mistyped_or_undeclared_fact_denies() {
    let base = || {
        Facts::new()
            .bool("actor_is_requester", false)
            .bool("actor_contributed", false)
            .bool("actor_holds_permission", true)
            .bool("step_up", true)
    };
    for facts in [
        base(),
        base().string("is_approval", "true"),
        holder().bool("client_says_ok", true),
        holder().long("other_eligible_holders", 1),
    ] {
        assert!(!exception(&facts), "{facts:?}");
    }
}

#[test]
fn an_unenrolled_action_stays_closed() {
    // `role_manage` is a matrix action with no per-action schema.
    assert!(!decide(Feature::RoleManage, OrgId::one(), &holder()));
    assert!(!decide(Feature::RoleManage, OrgId::one(), &Facts::new()));
}
