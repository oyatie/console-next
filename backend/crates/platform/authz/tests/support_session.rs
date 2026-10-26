// SPDX-License-Identifier: LicenseRef-Proprietary
//! Support access has no solo-operator or inherited tenant-role bypass.
#![allow(clippy::unwrap_used)]

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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn loaded_session_scope_state_and_reveal_grant_decide_each_read(owner: sqlx::PgPool) {
    use console_kernel_core::OrgId;
    use console_platform_authz::cedar_pbac::visible::load_support_session;
    use console_platform_test_support::{runtime_role_pool, seed_org_rls_off};
    use uuid::Uuid;
    let org = OrgId::from_uuid(Uuid::new_v4());
    let id = Uuid::new_v4();
    seed_org_rls_off(&owner, *org.as_uuid(), "support-facts").await;
    sqlx::query("INSERT INTO support_sessions(org_id,id,operator_ref,operator_label,ticket_ref,reason_code,reason,scope,requested_duration_seconds,approved_duration_seconds,request_expires_at,request_assertion,operator_approver_ref,operator_approved_at,approval_assertion,tenant_approver_ref,tenant_approved_at,state,started_at,expires_at) VALUES($1,$2,$3,'Operator','Ticket','DIAGNOSE','Scope check',ARRAY['org'],60,60,now()+interval '1 hour',$4,$5,now(),$6,$7,now(),'ACTIVE',now(),now()+interval '1 minute')")
        .bind(org.as_uuid()).bind(id).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&owner).await.unwrap();
    let rt = runtime_role_pool(&owner).await;
    let mut tx = rt.begin().await.unwrap();
    let session = load_support_session(&mut tx, org, id).await.unwrap();
    let read = |facts| {
        decide(
            Action::Read,
            PrincipalKind::Support,
            "session",
            "tenant",
            "tenant",
            facts,
        )
    };
    let field = |facts| {
        decide(
            Action::FieldRead,
            PrincipalKind::Support,
            "session",
            "tenant",
            "tenant",
            facts,
        )
    };
    assert!(read(session.facts(Some("org"), None)));
    assert!(!read(session.facts(Some("hr_basic"), None)));
    assert!(field(session.facts(Some("org"), Some("metadata"))));
    assert!(!field(session.facts(Some("org"), Some("personal"))));
    sqlx::query("UPDATE support_sessions SET reveal_classes=ARRAY['personal'],masked=false WHERE org_id=$1 AND id=$2").bind(org.as_uuid()).bind(id).execute(tx.as_mut()).await.unwrap();
    let session = load_support_session(&mut tx, org, id).await.unwrap();
    assert!(field(session.facts(Some("org"), Some("personal"))));
    assert!(!field(session.facts(Some("org"), Some("sensitive"))));
    sqlx::query(
        "UPDATE support_sessions SET state='REVOKED',ended_at=now() WHERE org_id=$1 AND id=$2",
    )
    .bind(org.as_uuid())
    .bind(id)
    .execute(tx.as_mut())
    .await
    .unwrap();
    let session = load_support_session(&mut tx, org, id).await.unwrap();
    assert!(!read(session.facts(Some("org"), None)));
    assert!(!field(session.facts(Some("org"), Some("personal"))));
    tx.rollback().await.unwrap();
    let mut tx = rt.begin().await.unwrap();
    assert!(
        load_support_session(&mut tx, OrgId::from_uuid(Uuid::new_v4()), id)
            .await
            .is_err()
    );
    let mut tx = owner.begin().await.unwrap();
    assert!(
        load_support_session(&mut tx, org, id).await.is_err(),
        "bypass-RLS owner cannot provide support authority"
    );
}
