// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[test]
fn support_principal_reads_only_its_active_approved_scope() {
    let facts = eligible();
    assert!(decide(
        Action::Read,
        PrincipalKind::Support,
        "session",
        "tenant",
        "tenant",
        facts
    ));
    for denied in [
        Facts {
            active: false,
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
        Facts {
            in_scope: false,
            ..facts
        },
    ] {
        assert!(!decide(
            Action::Read,
            PrincipalKind::Support,
            "session",
            "tenant",
            "tenant",
            denied
        ));
    }
    assert!(!decide(
        Action::Read,
        PrincipalKind::Support,
        "session",
        "other",
        "tenant",
        facts
    ));
    assert!(!vendor(Action::Read, facts));
}

#[test]
fn support_principal_cannot_request_approve_start_or_end() {
    for action in [
        Action::ActiveList,
        Action::List,
        Action::Request,
        Action::OperatorApprove,
        Action::TenantApprove,
        Action::Start,
        Action::End,
    ] {
        assert!(
            !decide(
                action,
                PrincipalKind::Support,
                "session",
                "tenant",
                "tenant",
                eligible()
            ),
            "{action:?}"
        );
    }
}

#[test]
fn every_write_feature_is_default_denied_to_support() {
    let mut writes = 0;
    for feature in Feature::ALL {
        let expected = matches!(access::tag(feature), Some((_, access::Level::View)));
        assert_eq!(
            require_feature(feature, "session", "tenant", eligible()).is_ok(),
            expected,
            "{feature:?}"
        );
        if !expected {
            writes += 1;
        }
    }
    assert!(writes > 0);
    assert!(
        require_feature(
            Feature::EmployeeDirectoryRead,
            "session",
            "tenant",
            Facts {
                in_scope: false,
                ..eligible()
            }
        )
        .is_err()
    );
}

#[test]
fn personal_fields_stay_masked_without_their_granted_class() {
    for (personal, reveal_granted, allowed) in [
        (false, false, true),
        (false, true, true),
        (true, false, false),
        (true, true, true),
    ] {
        assert_eq!(
            decide(
                Action::FieldRead,
                PrincipalKind::Support,
                "session",
                "tenant",
                "tenant",
                Facts {
                    personal,
                    reveal_granted,
                    ..eligible()
                },
            ),
            allowed,
        );
    }
}

#[test]
fn absent_authority_defaults_to_deny_for_every_action() {
    for action in [
        Action::ActiveList,
        Action::List,
        Action::Request,
        Action::OperatorApprove,
        Action::TenantApprove,
        Action::Start,
        Action::End,
        Action::Read,
        Action::FieldRead,
    ] {
        for kind in [
            PrincipalKind::Operator,
            PrincipalKind::Tenant,
            PrincipalKind::Support,
        ] {
            assert!(!decide(
                action,
                kind,
                "actor",
                "tenant",
                "tenant",
                Facts {
                    active: false,
                    vendor: false,
                    step_up: false,
                    other_eligible_holders: 0,
                    actor_is_requester: false,
                    actor_holds_permission: false,
                    operator_approved: false,
                    tenant_approved: false,
                    in_scope: false,
                    personal: false,
                    reveal_granted: false,
                }
            ));
        }
    }
}

#[test]
fn mutation_refusal_is_the_cedar_forbid_reason() {
    use crate::cedar_pbac::actions::support_session::require;
    assert_eq!(
        require(
            Action::Write,
            PrincipalKind::Support,
            "session",
            "tenant",
            "tenant",
            eligible()
        ),
        Err("support.refuse.read_only")
    );
    assert_eq!(
        require(
            Action::Write,
            PrincipalKind::Operator,
            "operator",
            "vendor",
            "tenant",
            eligible()
        ),
        Err("forbidden")
    );
}

#[test]
fn metadata_list_requires_live_operator_or_tenant_permission() {
    assert!(vendor(Action::List, eligible()));
    for facts in [
        Facts {
            active: false,
            ..eligible()
        },
        Facts {
            vendor: false,
            ..eligible()
        },
    ] {
        assert!(!vendor(Action::List, facts));
    }
    let tenant = Facts {
        vendor: false,
        ..eligible()
    };
    let list = |org, facts| {
        decide(
            Action::List,
            PrincipalKind::Tenant,
            "tenant-user",
            org,
            "tenant",
            facts,
        )
    };
    assert!(list("tenant", tenant));
    assert!(!list("other", tenant));
    assert!(!list(
        "tenant",
        Facts {
            actor_holds_permission: false,
            ..tenant
        }
    ));
}
