#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Every Cedar `forbid` in the MVP actions, proved to override a satisfied
//! `permit`: the facts first allow, then the forbid's trigger alone flips the
//! answer to a deny, and its escape hatch (where it has one) is exactly as
//! narrow as the policy says (tools/ci/check-refusal-tests.mjs).

use std::collections::BTreeSet;

use console_kernel_core::{BranchScope, ErrorKind, OrgId, UserId};
use console_platform_authz::cedar_pbac::actions::tenant_go_live::{self, GoLiveFacts};
use console_platform_authz::cedar_pbac::enforce::enforce_action;
use console_platform_authz::cedar_pbac::facts::Facts;
use console_platform_authz::{AuthorizationResource, Feature, Principal, Role};

fn change_request_decide(org: OrgId, facts: &Facts) -> bool {
    let principal = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::Admin]),
        BranchScope::All,
    );
    let resource = AuthorizationResource::org_wide(org, "change_request");
    match enforce_action(&principal, Feature::ChangeRequestDecide, resource, facts) {
        Ok(()) => true,
        Err(err) => {
            assert_eq!(err.kind, ErrorKind::Forbidden, "{err:?}");
            false
        }
    }
}

/// Another holder applying a request someone else filed, routed for approval.
fn holder() -> Facts {
    Facts::new()
        .bool("actor_is_requester", false)
        .bool("actor_holds_permission", true)
        .long("other_eligible_holders", 1)
        .bool("step_up", true)
        .string("sole_holder_mode", "refuse")
        .bool("is_apply", true)
        .bool("approval_routed", true)
}

#[test]
fn change_request_decide_forbids_the_requester_over_a_satisfied_permit() {
    assert!(change_request_decide(OrgId::one(), &holder()));
    assert!(!change_request_decide(
        OrgId::one(),
        &holder().bool("actor_is_requester", true)
    ));
    assert!(!change_request_decide(
        OrgId::one(),
        &holder().bool("actor_holds_permission", false)
    ));
    assert!(
        !change_request_decide(OrgId::new(), &holder()),
        "another tenant's request"
    );
}

#[test]
fn the_requesters_sole_holder_escape_needs_every_condition() {
    let sole = || {
        holder()
            .bool("actor_is_requester", true)
            .long("other_eligible_holders", 0)
            .string("sole_holder_mode", "step_up_notice_review")
    };
    assert!(change_request_decide(OrgId::one(), &sole()));
    assert!(!change_request_decide(
        OrgId::one(),
        &sole().bool("step_up", false)
    ));
    assert!(
        !change_request_decide(OrgId::one(), &sole().bool("is_apply", false)),
        "a decline is never the requester's"
    );
    assert!(!change_request_decide(
        OrgId::one(),
        &sole().long("other_eligible_holders", 1)
    ));
    assert!(!change_request_decide(
        OrgId::one(),
        &sole().string("sole_holder_mode", "refuse")
    ));
}

#[test]
fn with_no_approval_route_the_requester_applies_only_with_step_up() {
    let unrouted = || {
        holder()
            .bool("actor_is_requester", true)
            .bool("approval_routed", false)
    };
    assert!(change_request_decide(OrgId::one(), &unrouted()));
    assert!(!change_request_decide(
        OrgId::one(),
        &unrouted().bool("step_up", false)
    ));
    assert!(!change_request_decide(
        OrgId::one(),
        &unrouted().bool("is_apply", false)
    ));
}

const READY: GoLiveFacts = GoLiveFacts {
    phase_is_setup: true,
    step_up: true,
    entities_ready: true,
    primary_workplaces_ready: true,
    org_change_route_resolvable: true,
    org_change_routed: true,
    other_eligible_holders: 1,
    sole_holder_acknowledged: false,
    security_contact_recorded: true,
    security_contact_store_available: true,
    terms_accepted: true,
    preview_digest_matches: true,
};

#[test]
fn tenant_go_live_forbids_any_phase_but_setup_and_every_unready_fact() {
    let decide = |roles: &[&str], f| tenant_go_live::decide("u", "o", roles, f);
    assert_eq!(decide(&["SUPER_ADMIN"], READY), Ok(true));
    let phase = GoLiveFacts {
        phase_is_setup: false,
        ..READY
    };
    assert_eq!(
        decide(&["SUPER_ADMIN"], phase),
        Ok(false),
        "OPERATING never goes live again"
    );
    assert_eq!(
        decide(&["ADMIN", "EXECUTIVE"], READY),
        Ok(false),
        "only the tenant's SUPER_ADMIN"
    );
    let flips: [fn(&mut GoLiveFacts); 7] = [
        |f| f.step_up = false,
        |f| f.entities_ready = false,
        |f| f.primary_workplaces_ready = false,
        |f| f.org_change_route_resolvable = false,
        |f| f.other_eligible_holders = 0,
        |f| f.terms_accepted = false,
        |f| f.preview_digest_matches = false,
    ];
    for flip in flips {
        let mut f = READY;
        flip(&mut f);
        assert_eq!(decide(&["SUPER_ADMIN"], f), Ok(false), "{f:?}");
    }
    let acknowledged = GoLiveFacts {
        other_eligible_holders: 0,
        sole_holder_acknowledged: true,
        ..READY
    };
    assert_eq!(decide(&["SUPER_ADMIN"], acknowledged), Ok(true));
    let no_contact = GoLiveFacts {
        security_contact_recorded: false,
        ..READY
    };
    assert_eq!(decide(&["SUPER_ADMIN"], no_contact), Ok(false));
    let no_store = GoLiveFacts {
        security_contact_store_available: false,
        ..no_contact
    };
    assert_eq!(decide(&["SUPER_ADMIN"], no_store), Ok(true));
}
