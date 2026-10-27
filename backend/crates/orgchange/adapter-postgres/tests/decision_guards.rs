// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "../../../../test-support/org_change_fixtures.rs"]
mod org_change_fixtures;
#[path = "../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

use console_kernel_core::OrgId;
use console_orgchange_adapter_postgres::PgOrgChangeStore;
use console_platform_request_context::scope_org;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_decisions_by_one_person_only_write_one_step(pool: PgPool) {
    let org = OrgId::new();
    let maker = seed_org_and_super_admin(&pool, *org.as_uuid(), "concurrent-decide").await;
    let actor = seed_active_user(&pool, *org.as_uuid(), "EXECUTIVE", "checker").await;
    person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    person_fixtures::bind_user_to_distinct_person(&pool, actor).await;
    org_change_fixtures::grant_org_approve(&pool, actor).await;
    let id: Uuid = sqlx::query_scalar("INSERT INTO org_change_requests(org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES($1,'OC-2026-0001','REORG','IN_APPROVAL','REGION','region','Region',CURRENT_DATE,'Review','[]',$2,$3,repeat('a',64)) RETURNING id")
        .bind(org.as_uuid()).bind(maker.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(&pool).await.unwrap();
    let mut steps = [Uuid::nil(); 2];
    for (index, step) in steps.iter_mut().enumerate() {
        *step = sqlx::query_scalar("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key) VALUES($1,$2,$3,'hr') RETURNING id")
            .bind(org.as_uuid()).bind(id).bind(i16::try_from(index + 1).unwrap()).fetch_one(&pool).await.unwrap();
    }
    let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
    let (first, second) = tokio::join!(
        scope_org(org, store.decide_step(actor, id, steps[0], true, None)),
        scope_org(org, store.decide_step(actor, id, steps[1], true, None)),
    );
    assert!(first.is_ok(), "{first:?}");
    if second.is_err() {
        let before = snapshot(&pool, id).await;
        let refused = scope_org(org, store.decide_step(actor, id, steps[1], true, None))
            .await
            .unwrap_err();
        assert!(
            matches!(refused, console_orgchange_adapter_postgres::PgOrgChangeError::Domain(e) if e.code == Some("org_change_sod_violation"))
        );
        assert_eq!(snapshot(&pool, id).await, before);
    } else {
        panic!("one person decided both steps");
    }
    let decisions: i64 = sqlx::query_scalar("SELECT count(*) FROM org_change_approval_steps WHERE request_id=$1 AND decision <> 'PENDING'")
        .bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(decisions, 1);

    use console_orgchange_adapter_postgres::PgOrgChangeError;
    use console_orgchange_domain::StepDecisionCommand;
    let before = snapshot(&pool, id).await;
    let stale = scope_org(
        org,
        store.decide_step_command(
            actor,
            id,
            steps[1],
            StepDecisionCommand {
                approved: true,
                expected_version: Some("stale".into()),
                ..Default::default()
            },
        ),
    )
    .await
    .unwrap_err();
    assert!(matches!(stale, PgOrgChangeError::StaleVersion(_)));
    assert_eq!(snapshot(&pool, id).await, before);
    let merged = scope_org(
        org,
        store.decide_step_command(
            actor,
            id,
            steps[1],
            StepDecisionCommand {
                approved: true,
                through_step: Some(steps[1]),
                ..Default::default()
            },
        ),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(merged, PgOrgChangeError::Domain(e) if e.code == Some("lifecycle.refuse.merge_not_allowed"))
    );
    assert_eq!(snapshot(&pool, id).await, before);
    sqlx::query("UPDATE org_change_requests SET status='CANCELLED' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let before = snapshot(&pool, id).await;
    let withdrawn = scope_org(
        org,
        store.decide_step_command(
            actor,
            id,
            steps[1],
            StepDecisionCommand {
                approved: true,
                expected_version: Some("stale".into()),
                ..Default::default()
            },
        ),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(withdrawn, PgOrgChangeError::Domain(e) if e.code == Some("lifecycle.refuse.withdrawn"))
    );
    assert_eq!(snapshot(&pool, id).await, before);
}

async fn snapshot(pool: &PgPool, id: Uuid) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array(to_jsonb(r),(SELECT jsonb_agg(to_jsonb(s) ORDER BY step_order) FROM org_change_approval_steps s WHERE request_id=r.id),(SELECT count(*) FROM gov_approvals),(SELECT count(*) FROM audit_events),(SELECT count(*) FROM org_change_events)) FROM org_change_requests r WHERE id=$1")
        .bind(id).fetch_one(pool).await.unwrap()
}
