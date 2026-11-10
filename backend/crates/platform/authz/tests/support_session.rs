// SPDX-License-Identifier: LicenseRef-Proprietary
//! Support authority is refreshed from the tenant's RLS transaction.
#![allow(clippy::unwrap_used)]
use console_platform_authz::cedar_pbac::actions::support_session::{Action, PrincipalKind, decide};

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
