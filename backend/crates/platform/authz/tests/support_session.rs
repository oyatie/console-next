// SPDX-License-Identifier: LicenseRef-Proprietary
//! Support access has no solo-operator or inherited tenant-role bypass.

use console_platform_authz::cedar_pbac::actions::support_session::{
    Action, Facts, PrincipalKind, decide, decide_feature, field_visible,
};
use console_platform_authz::{Feature, access};

fn eligible() -> Facts {
    Facts {
        active: true,
        vendor: true,
        step_up: true,
        other_eligible_holders: 1,
        actor_is_requester: false,
        actor_holds_permission: true,
        operator_approved: true,
        tenant_approved: true,
        in_scope: true,
        personal: false,
        reveal_granted: false,
    }
}

fn vendor(action: Action, facts: Facts) -> bool {
    decide(
        action,
        PrincipalKind::Operator,
        "operator",
        "vendor",
        "tenant",
        facts,
    )
}

#[test]
fn vendor_actions_require_fresh_step_up_and_another_eligible_operator() {
    for action in [Action::Request, Action::OperatorApprove, Action::Start] {
        let facts = Facts {
            actor_is_requester: action != Action::OperatorApprove,
            ..eligible()
        };
        assert!(vendor(action, facts), "{action:?}");
        for denied in [
            Facts {
                step_up: false,
                ..facts
            },
            Facts {
                other_eligible_holders: 0,
                ..facts
            },
            Facts {
                other_eligible_holders: -1,
                ..facts
            },
            Facts {
                active: false,
                ..facts
            },
            Facts {
                vendor: false,
                ..facts
            },
            Facts {
                actor_holds_permission: false,
                ..facts
            },
        ] {
            assert!(!vendor(action, denied), "{action:?}: {denied:?}");
        }
    }
}

#[test]
fn requester_cannot_approve_even_with_all_other_facts() {
    assert!(!vendor(
        Action::OperatorApprove,
        Facts {
            actor_is_requester: true,
            ..eligible()
        }
    ));
}

#[test]
fn live_requester_can_end_when_step_up_or_a_second_operator_is_unavailable() {
    let facts = Facts {
        actor_is_requester: true,
        step_up: false,
        other_eligible_holders: 0,
        actor_holds_permission: false,
        ..eligible()
    };
    assert!(vendor(Action::End, facts));
    assert!(!vendor(
        Action::End,
        Facts {
            actor_is_requester: false,
            ..facts
        }
    ));
    assert!(!vendor(
        Action::End,
        Facts {
            active: false,
            ..facts
        }
    ));
}

#[test]
fn tenant_approval_comes_from_a_permission_in_the_target_tenant() {
    let facts = Facts {
        vendor: false,
        step_up: false,
        other_eligible_holders: 0,
        ..eligible()
    };
    assert!(decide(
        Action::TenantApprove,
        PrincipalKind::Tenant,
        "approver",
        "tenant",
        "tenant",
        facts
    ));
    for denied in [
        Facts {
            actor_holds_permission: false,
            ..facts
        },
        Facts {
            operator_approved: false,
            ..facts
        },
        Facts {
            active: false,
            ..facts
        },
        Facts {
            vendor: true,
            ..facts
        },
    ] {
        assert!(!decide(
            Action::TenantApprove,
            PrincipalKind::Tenant,
            "approver",
            "tenant",
            "tenant",
            denied
        ));
    }
    assert!(!decide(
        Action::TenantApprove,
        PrincipalKind::Tenant,
        "approver",
        "other",
        "tenant",
        facts
    ));
}

#[test]
fn start_requires_both_approvals_and_the_requester() {
    let facts = Facts {
        actor_is_requester: true,
        ..eligible()
    };
    assert!(vendor(Action::Start, facts));
    for denied in [
        Facts {
            actor_is_requester: false,
            ..facts
        },
        Facts {
            operator_approved: false,
            ..facts
        },
        Facts {
            tenant_approved: false,
            ..facts
        },
    ] {
        assert!(!vendor(Action::Start, denied));
    }
}

#[test]
fn tenant_can_end_without_vendor_step_up_but_needs_its_permission() {
    let facts = Facts {
        vendor: false,
        step_up: false,
        other_eligible_holders: 0,
        ..eligible()
    };
    assert!(decide(
        Action::End,
        PrincipalKind::Tenant,
        "approver",
        "tenant",
        "tenant",
        facts
    ));
    assert!(!decide(
        Action::End,
        PrincipalKind::Tenant,
        "approver",
        "other",
        "tenant",
        facts
    ));
    assert!(!decide(
        Action::End,
        PrincipalKind::Tenant,
        "approver",
        "tenant",
        "tenant",
        Facts {
            actor_holds_permission: false,
            ..facts
        }
    ));
}

#[path = "support_session/reads.rs"]
mod reads;
