// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_support_permission_requires_live_rls_facts(owner: PgPool) {
    let h = Support::new(owner).await;
    let user: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops")
        .bind(h.org)
        .fetch_one(&h.owner)
        .await
        .unwrap();
    let org = OrgId::from_uuid(h.org);
    let mut tx = h.owner.begin().await.unwrap();
    assert!(
        console_platform_rest::tenant_support_permission(&mut tx, org, user)
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    let mut tx = h.rt.begin().await.unwrap();
    assert!(
        console_platform_rest::tenant_support_permission(&mut tx, org, user)
            .await
            .unwrap()
    );
    tx.rollback().await.unwrap();
    let reader: Uuid =
        sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND NOT is_tenant_ops LIMIT 1")
            .bind(h.org)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(reader)
        .execute(&h.owner)
        .await
        .unwrap();
    let mut tx = h.rt.begin().await.unwrap();
    assert!(
        console_platform_rest::tenant_support_permission(&mut tx, org, reader)
            .await
            .is_err()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn operator_facts_bind_live_identity_assertion_and_session(owner: PgPool) {
    use console_platform_authz::cedar_pbac::{
        actions::support_session::{Action, PrincipalKind, require},
        visible::load_operator_facts,
    };
    let mut h = Support::new(owner).await;
    let id = Uuid::new_v4();
    ok(h.request(id).await, StatusCode::CREATED);
    let assertion: Uuid =
        sqlx::query_scalar("SELECT request_assertion FROM support_sessions WHERE id=$1")
            .bind(id)
            .fetch_one(&h.owner)
            .await
            .unwrap();
    let target = Some((OrgId::from_uuid(h.org), id));
    let decide = |action, facts| {
        require(
            action,
            PrincipalKind::Operator,
            "operator",
            "vendor",
            "tenant",
            facts,
        )
    };
    let mut tx = h.owner.begin().await.unwrap();
    assert!(
        load_operator_facts(&mut tx, h.a.id, Some((assertion, id)), target)
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    let mut tx = h.rt.begin().await.unwrap();
    let facts = load_operator_facts(&mut tx, h.a.id, Some((assertion, id)), target)
        .await
        .unwrap();
    assert_eq!(decide(Action::Request, facts), Ok(()));
    assert_eq!(
        decide(Action::OperatorApprove, facts),
        Err("support.refuse.requester_cannot_approve")
    );
    let facts = load_operator_facts(&mut tx, h.a.id, Some((assertion, Uuid::new_v4())), target)
        .await
        .unwrap();
    assert_eq!(decide(Action::Request, facts), Err("forbidden"));
    let facts = load_operator_facts(&mut tx, h.a.id, None, target)
        .await
        .unwrap();
    assert_eq!(decide(Action::Request, facts), Err("forbidden"));
    let facts = load_operator_facts(&mut tx, h.b.id, Some((assertion, id)), target)
        .await
        .unwrap();
    assert_eq!(decide(Action::OperatorApprove, facts), Err("forbidden"));
    tx.rollback().await.unwrap();
    let second = Uuid::new_v4();
    ok(h.request(second).await, StatusCode::CREATED);
    let mut tx = h.rt.begin().await.unwrap();
    let facts = load_operator_facts(
        &mut tx,
        h.a.id,
        Some((assertion, id)),
        Some((OrgId::from_uuid(h.org), second)),
    )
    .await
    .unwrap();
    assert_eq!(decide(Action::Request, facts), Err("forbidden"));
    tx.rollback().await.unwrap();
    sqlx::query("UPDATE users SET roles=ARRAY[]::text[] WHERE id=$1")
        .bind(h.a.id.as_uuid())
        .execute(&h.owner)
        .await
        .unwrap();
    let mut tx = h.rt.begin().await.unwrap();
    let facts = load_operator_facts(&mut tx, h.a.id, Some((assertion, id)), target)
        .await
        .unwrap();
    assert_eq!(decide(Action::List, facts), Err("forbidden"));
}
