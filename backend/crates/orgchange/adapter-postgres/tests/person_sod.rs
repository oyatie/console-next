#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

use console_kernel_core::{ErrorKind, OrgId};
use console_orgchange_adapter_postgres::PgOrgChangeStore;
use console_platform_request_context::scope_org;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn routed_approval_refuses_same_person_accounts_without_decision_or_audit(pool: PgPool) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    let maker = seed_org_and_super_admin(&pool, *org.as_uuid(), "person-orgchange").await;
    let (_, person) = person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let same = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "same").await;
    person_fixtures::bind_user_to_person(&pool, same, person).await;
    let same_person_alias =
        seed_active_user(&pool, *org.as_uuid(), "ADMIN", "same-person-alias").await;
    person_fixtures::bind_user_to_person(&pool, same_person_alias, person).await;
    let checker = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "independent").await;
    person_fixtures::bind_user_to_distinct_person(&pool, checker).await;
    let request: Uuid = sqlx::query_scalar("INSERT INTO org_change_requests (org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,'OC-2026-0001','REORG','IN_APPROVAL','REGION','region','Region',CURRENT_DATE,'Review','[]',$2,$3,repeat('a',64)) RETURNING id")
        .bind(org.as_uuid()).bind(maker.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(&pool).await.unwrap();
    let step: Uuid = sqlx::query_scalar("INSERT INTO org_change_approval_steps (org_id,request_id,step_order,role_key) VALUES ($1,$2,1,'hr') RETURNING id")
        .bind(org.as_uuid()).bind(request).fetch_one(&pool).await.unwrap();
    let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
    let before = snapshot(&pool, step).await;
    for actor in [same, same_person_alias, same] {
        for approved in [true, false] {
            let err = scope_org(org, store.decide_step(actor, request, step, approved, None))
                .await
                .unwrap_err();
            assert_eq!(err.kind(), ErrorKind::Conflict);
            assert!(
                err.to_string()
                    .contains("기안자는 자신의 조직 개편을 승인할 수 없습니다.")
            );
            assert_eq!(snapshot(&pool, step).await, before);
        }
    }
    scope_org(org, store.decide_step(checker, request, step, true, None))
        .await
        .unwrap();
    assert_eq!(snapshot(&pool, step).await.0["decision"], "APPROVED");
}

async fn snapshot(pool: &PgPool, step: Uuid) -> (Value, i64, i64, i64) {
    sqlx::query_as("SELECT to_jsonb(s), (SELECT count(*) FROM gov_approvals), (SELECT count(*) FROM org_change_events), (SELECT count(*) FROM audit_events) FROM org_change_approval_steps s WHERE id=$1")
        .bind(step).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn distinct_accounts_can_approve_and_reject_with_zero_one_or_two_person_bindings(
    pool: PgPool,
) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    let maker = seed_org_and_super_admin(&pool, *org.as_uuid(), "unlinked-orgchange").await;
    let checker = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "checker").await;
    let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
    for bindings in 0..3 {
        if bindings == 1 {
            person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
        } else if bindings == 2 {
            person_fixtures::bind_user_to_distinct_person(&pool, checker).await;
        }
        for approved in [true, false] {
            let code = format!("OC-2026-{:04}", bindings * 2 + i32::from(approved) + 1);
            let request: Uuid = sqlx::query_scalar("INSERT INTO org_change_requests (org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES ($1,$2,'REORG','IN_APPROVAL','REGION','region','Region',CURRENT_DATE,'Review','[]',$3,$4,repeat('a',64)) RETURNING id")
                .bind(org.as_uuid()).bind(code).bind(maker.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(&pool).await.unwrap();
            let step: Uuid = sqlx::query_scalar("INSERT INTO org_change_approval_steps (org_id,request_id,step_order,role_key) VALUES ($1,$2,1,'hr') RETURNING id")
                .bind(org.as_uuid()).bind(request).fetch_one(&pool).await.unwrap();
            let before = snapshot(&pool, step).await;
            scope_org(
                org,
                store.decide_step(checker, request, step, approved, None),
            )
            .await
            .unwrap();
            let after = snapshot(&pool, step).await;
            assert_eq!(
                after.0["decision"],
                if approved { "APPROVED" } else { "REJECTED" }
            );
            assert_eq!(after.0["decided_by"], checker.to_string());
            assert_eq!(
                (after.1, after.2, after.3),
                (before.1 + 1, before.2 + 1, before.3 + 1)
            );
        }
    }
}
