// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::*;
use console_kernel_core::OrgId;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

#[path = "../../tests/access_log_review_flags/statements.rs"]
mod statements;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn open_review_queries_stay_constant_at_two_thousand_accounts(owner: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&owner, *org.as_uuid(), "review-scale").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(actor.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    let exception: Uuid = sqlx::query_scalar(
        "WITH lock AS (INSERT INTO period_locks(org_id,domain,period_start,period_end,reason_code) \
         VALUES($1,'accounting','2026-06-01','2026-06-30','BOOKS_CLOSE') RETURNING id) \
         INSERT INTO governed_exceptions(org_id,rule_code,risk,subject_type,subject_id,reason_code,fingerprint,settings_snapshot,requested_by,step_up_assertion_id,status,fallback_kind,review_due_at,expires_at,consumed_at) \
         SELECT $1,'PERIOD_UNLOCK_SOLE_HOLDER','HIGH','PERIOD_LOCK',id,'AUDIT_FINDING',repeat('a',64),'{}',$2,gen_random_uuid(),'RECORDED','SOLE_HOLDER',now()+interval '1 day',now()+interval '1 day',now() FROM lock RETURNING id")
        .bind(org.as_uuid()).bind(actor.as_uuid()).fetch_one(&owner).await.unwrap();
    let runtime = runtime_role_pool(&owner).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let principal = Principal::new(
        actor,
        org,
        Default::default(),
        console_kernel_core::BranchScope::All,
    );
    let mut counts = Vec::new();
    for accounts in [1_i32, 2_000] {
        if accounts > 1 {
            sqlx::query("INSERT INTO users(org_id,display_name,roles) SELECT $1,'일반 계정',ARRAY['MEMBER'] FROM generate_series(2,$2)")
                .bind(org.as_uuid()).bind(accounts).execute(&owner).await.unwrap();
        }
        let queries = statements::Statements::default();
        let items = items(&mut tx, &principal, OffsetDateTime::now_utc())
            .with_subscriber(queries.dispatch())
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, format!("period_unlock:{exception}"));
        let count = queries.take().len();
        assert!(count > 0, "SQL observer must record the review source");
        counts.push(count);
    }
    eprintln!("open review SQL statements at 1/2000 accounts: {counts:?}");
    assert_eq!(
        counts,
        vec![3, 3],
        "one pending read, one holder resolution, one person read"
    );
}
