// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
use console_kernel_core::{OrgId, UserId};
use console_orgchange_adapter_postgres::{PgOrgChangeError, PgOrgChangeStore};
use console_orgchange_domain::OrgChangeStatus;
use console_platform_request_context::scope_org;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn withdrawal_is_drafter_only_and_keeps_the_approval_chain(pool: PgPool) {
    let org = OrgId::new();
    let ops = seed_org_and_super_admin(&pool, *org.as_uuid(), "withdrawal").await;
    let maker = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "maker").await;
    let (id, _) = request(&pool, org, maker).await;
    let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
    let before = snapshot(&pool, id).await;
    let refusal = scope_org(org, store.cancel(ops, id, "Other drafter".into()))
        .await
        .unwrap_err();
    assert!(
        matches!(refusal, PgOrgChangeError::Domain(e) if e.code == Some("org_change.refuse.not_drafter"))
    );
    assert_eq!(snapshot(&pool, id).await, before);
    let cancelled = scope_org(
        org,
        store.cancel(maker, id, "Add approvers before resubmitting".into()),
    )
    .await
    .unwrap();
    assert_eq!(cancelled.summary.status, OrgChangeStatus::Cancelled);
    let after = snapshot(&pool, id).await;
    assert_eq!(after[1], before[1]);
    assert_eq!(after[2].as_i64(), Some(before[2].as_i64().unwrap() + 1));
    let unrelated = UserId::new();
    assert!(
        scope_org(org, store.cancel(unrelated, id, "Unknown account".into()))
            .await
            .is_err()
    );
    assert_eq!(snapshot(&pool, id).await, after);
}

async fn snapshot(pool: &PgPool, id: Uuid) -> serde_json::Value {
    sqlx::query_scalar("SELECT jsonb_build_array(to_jsonb(r),(SELECT jsonb_agg(to_jsonb(s)) FROM org_change_approval_steps s WHERE request_id=r.id),(SELECT count(*) FROM audit_events)) FROM org_change_requests r WHERE id=$1")
        .bind(id).fetch_one(pool).await.unwrap()
}

async fn request(pool: &PgPool, org: OrgId, maker: UserId) -> (Uuid, Uuid) {
    let id: Uuid = sqlx::query_scalar("INSERT INTO org_change_requests(org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES($1,'OC-2026-0001','REORG','IN_APPROVAL','REGION','region','Region',CURRENT_DATE,'Review','[]',$2,$3,repeat('a',64)) RETURNING id")
        .bind(org.as_uuid()).bind(maker.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
    let step = sqlx::query_scalar("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key) VALUES($1,$2,1,'hr') RETURNING id")
        .bind(org.as_uuid()).bind(id).fetch_one(pool).await.unwrap();
    (id, step)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn withdrawal_timestamp_follows_the_decision_it_waited_for(pool: PgPool) {
    let org = OrgId::new();
    let checker = seed_org_and_super_admin(&pool, *org.as_uuid(), "withdrawal-clock").await;
    let maker = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "maker").await;
    let (id, step) = request(&pool, org, maker).await;
    sqlx::query("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key) VALUES($1,$2,2,'hr')")
        .bind(org.as_uuid()).bind(id).execute(&pool).await.unwrap();
    let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
    let mut decision = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM org_change_requests WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(decision.as_mut())
        .await
        .unwrap();
    let mut withdrawal = std::pin::pin!(scope_org(
        org,
        store.cancel(maker, id, "Withdraw after review".into())
    ));
    // Poll once while the request is locked; the withdrawal must wait.
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(withdrawal.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    let decided_at: time::OffsetDateTime = sqlx::query_scalar(
        "UPDATE org_change_approval_steps SET decision='APPROVED',decided_by=$2,decided_at=$3 WHERE id=$1 RETURNING decided_at")
        .bind(step).bind(checker.as_uuid()).bind(time::OffsetDateTime::now_utc())
        .fetch_one(decision.as_mut()).await.unwrap();
    decision.commit().await.unwrap();
    let cancelled = withdrawal.await.unwrap();
    assert_eq!(cancelled.summary.status, OrgChangeStatus::Cancelled);
    assert!(
        cancelled.summary.updated_at > decided_at,
        "withdrawal must receive a new timestamp after the decision commits"
    );
    assert_ne!(
        cancelled.version,
        console_orgchange_domain::decision_version(decided_at, None)
    );
}
