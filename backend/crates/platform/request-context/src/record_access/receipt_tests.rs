use super::{access_tests::Fixture, may_read};
use console_kernel_core::BranchScope;
use console_platform_test_support::MIGRATOR;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use uuid::Uuid;

async fn receipt(f: &Fixture, ops: Value) -> Uuid {
    sqlx::query_scalar("INSERT INTO access_grant_receipts (org_id,actor_id,digest,request,refused,expires_at) VALUES ($1,$2,$3,$4,0,now()+interval '10 minutes') RETURNING id")
        .bind(f.org.as_uuid()).bind(f.actor.as_uuid()).bind("a".repeat(64))
        .bind(json!({"ops":ops,"reason_code":"TEST","reason_note":null}))
        .fetch_one(&f.owner).await.unwrap() // rls-arming: ok owner fixture
}
fn new_grant(entity: Uuid) -> Value {
    json!({"op":"grant","grant_id":Uuid::new_v4(),"account_id":Uuid::new_v4(),
        "role_id":Uuid::new_v4(),"scope":{"kind":"LEGAL_ENTITY","node_id":entity,
        "include_descendants":true},"effective_in_setup":true,
        "valid_from":"2026-10-09T00:00:00Z","valid_to":null})
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn scoped_receipt_reader_requires_every_normalized_operation_scope(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let role = f.role().await;
    f.grant(role, f.reader, Some(f.entities[0])).await;
    let p = f.principal(BranchScope::Branches(BTreeSet::from([f.branches[0]])));
    let inside = f.grant(role, f.target, Some(f.entities[0])).await;
    let outside = f.grant(role, f.target, Some(f.entities[1])).await;
    let allowed = receipt(
        &f,
        json!([new_grant(f.entities[0]),
        {"op":"revoke","grant_id":inside},
        {"op":"set_end","grant_id":inside,"valid_to":null}]),
    )
    .await;
    assert!(
        may_read(
            &f.rt,
            &p,
            "access_grant_receipts",
            &allowed.to_string(),
            None
        )
        .await
    );
    let mixed = receipt(
        &f,
        json!([new_grant(f.entities[0]), new_grant(f.entities[1])]),
    )
    .await;
    let mixed_revoke = receipt(
        &f,
        json!([new_grant(f.entities[0]),
        {"op":"revoke","grant_id":outside}]),
    )
    .await;
    let unknown_grant = receipt(
        &f,
        json!([{"op":"set_end","grant_id":Uuid::new_v4(),
        "valid_to":null}]),
    )
    .await;
    for id in [mixed, mixed_revoke, unknown_grant, Uuid::new_v4()] {
        assert!(!may_read(&f.rt, &p, "access_grant_receipts", &id.to_string(), None).await);
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn tenant_receipt_reader_still_denies_unknown_nodes_and_malformed_operations(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let role = f.role().await;
    f.grant(role, f.reader, None).await;
    let p = f.principal(BranchScope::All);
    let both = receipt(
        &f,
        json!([new_grant(f.entities[0]), new_grant(f.entities[1])]),
    )
    .await;
    assert!(may_read(&f.rt, &p, "access_grant_receipts", &both.to_string(), None).await);
    for ops in [
        json!([]),
        json!([new_grant(Uuid::new_v4())]),
        json!([{"op":"unexpected"}]),
        json!([{"op":"grant","scope":{"kind":"UNKNOWN"}}]),
        json!([{"op":"revoke","grant_id":Uuid::new_v4()}]),
    ] {
        let id = receipt(&f, ops).await;
        assert!(!may_read(&f.rt, &p, "access_grant_receipts", &id.to_string(), None).await);
    }
    assert!(!may_read(&f.rt, &p, "access_grant_receipts", "bad-id", None).await);
}
