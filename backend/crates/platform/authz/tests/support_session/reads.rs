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
            decide_feature(feature, "session", "tenant", eligible()),
            expected,
            "{feature:?}"
        );
        if !expected {
            writes += 1;
        }
    }
    assert!(writes > 0);
    assert!(!decide_feature(
        Feature::EmployeeDirectoryRead,
        "session",
        "tenant",
        Facts {
            in_scope: false,
            ..eligible()
        }
    ));
}

#[test]
fn personal_fields_stay_masked_without_their_granted_class() {
    assert!(field_visible(false, false));
    assert!(field_visible(false, true));
    assert!(!field_visible(true, false));
    assert!(field_visible(true, true));
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
                Facts::default()
            ));
        }
    }
}
