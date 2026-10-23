#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

use console_kernel_core::{OrgId, UserId};
use console_payroll_adapter_postgres::lifecycle::{LifecycleError, decide_run_in_tx};
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn approvals_and_rejections_refuse_shared_identities_and_preserve_the_run(pool: PgPool) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    let maker = seed_org_and_super_admin(&pool, *org.as_uuid(), "person-payroll").await;
    let (_, person) = person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let same = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "same").await;
    person_fixtures::bind_user_to_person(&pool, same, person).await;
    let checker = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "independent").await;
    person_fixtures::bind_user_to_distinct_person(&pool, checker).await;
    let same_person_alias =
        seed_active_user(&pool, *org.as_uuid(), "ADMIN", "same-person-alias").await;
    person_fixtures::bind_user_to_person(&pool, same_person_alias, person).await;
    let unknown = UserId::new();
    assert_ne!(maker, same);
    let rt = runtime_role_pool(&pool).await;
    for (submitter, decider) in [
        (Some(maker), maker),
        (Some(maker), unknown),
        (Some(maker), same),
        (Some(maker), same_person_alias),
        (Some(same_person_alias), maker),
        (None, checker),
        (Some(maker), UserId::new()),
    ] {
        let run: Uuid = sqlx::query_scalar("INSERT INTO payroll_draft_runs (org_id,period_start,period_end,source_label,status,submitted_by) VALUES ($1,'2026-01-01','2026-01-31',$2,'SUBMITTED',$3) RETURNING id")
            .bind(org.as_uuid()).bind(Uuid::new_v4().to_string()).bind(submitter.map(|u| *u.as_uuid()))
            .fetch_one(&pool).await.unwrap();
        let before = snapshot(&pool, run).await;
        for decision in ["APPROVE", "REJECT", "APPROVE"] {
            let mut tx = rt.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.current_org',$1,true)")
                .bind(org.to_string())
                .execute(tx.as_mut())
                .await
                .unwrap();
            let err = decide_run_in_tx(&mut tx, run, *decider.as_uuid(), decision, Some("review"))
                .await
                .expect_err("shared identity or missing account must refuse");
            assert!(matches!(
                err,
                LifecycleError::SodViolation | LifecycleError::IdentityUnbound
            ));
            tx.rollback().await.unwrap();
            assert_eq!(snapshot(&pool, run).await, before);
        }
    }
    for unlinked in [None, Some(maker), Some(checker)] {
        if let Some(account) = unlinked {
            sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
                .bind(account.as_uuid())
                .execute(&pool)
                .await
                .unwrap();
        }
        let run: Uuid = sqlx::query_scalar("INSERT INTO payroll_draft_runs (org_id,period_start,period_end,source_label,status,submitted_by) VALUES ($1,'2026-02-01','2026-02-28',$2,'SUBMITTED',$3) RETURNING id")
            .bind(org.as_uuid()).bind(Uuid::new_v4().to_string()).bind(maker.as_uuid()).fetch_one(&pool).await.unwrap();
        let mut tx = rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        decide_run_in_tx(&mut tx, run, *checker.as_uuid(), "APPROVE", None)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(snapshot(&pool, run).await.0["status"], "APPROVED");
    }
}

async fn snapshot(pool: &PgPool, run: Uuid) -> (Value, i64) {
    sqlx::query_as("SELECT to_jsonb(r), (SELECT count(*) FROM audit_events) FROM payroll_draft_runs r WHERE id=$1")
        .bind(run).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unbound_maker_or_checker_has_its_own_refusal(pool: PgPool) {
    let org = OrgId::from_uuid(Uuid::new_v4());
    let maker = seed_org_and_super_admin(&pool, *org.as_uuid(), "unbound-payroll").await;
    let checker = seed_active_user(&pool, *org.as_uuid(), "ADMIN", "checker").await;
    let run:Uuid=sqlx::query_scalar("INSERT INTO payroll_draft_runs(org_id,period_start,period_end,source_label,status,submitted_by) VALUES($1,'2026-01-01','2026-01-31','unbound','SUBMITTED',$2) RETURNING id").bind(org.as_uuid()).bind(maker.as_uuid()).fetch_one(&pool).await.unwrap();
    let rt = runtime_role_pool(&pool).await;
    for user in [checker, maker] {
        let mut identity = pool.begin().await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops=false,person_id=COALESCE(public.console_employee_person(org_id,employee_id),id) WHERE id=ANY($1)")
            .bind(vec![*maker.as_uuid(),*checker.as_uuid()]).execute(identity.as_mut()).await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
            .bind(user.as_uuid())
            .execute(identity.as_mut())
            .await
            .unwrap();
        identity.commit().await.unwrap();
        let mut tx = rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let error = decide_run_in_tx(&mut tx, run, *checker.as_uuid(), "APPROVE", None)
            .await
            .unwrap_err()
            .into_kernel_error();
        assert_eq!(error.code, Some("payroll.refuse.identity_unbound"));
        tx.rollback().await.unwrap();
    }
}
