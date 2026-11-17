// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{review_support::*, *};
use console_identity_adapter_postgres::self_binding_review::ReviewDecision;
use sqlx::ConnectOptions;
use tracing::instrument::WithSubscriber;
#[path = "../account_link_solo/query_count.rs"]
mod query_count;

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn review_inbox_only_reveals_current_bindings_to_independent_eligible_people(pool: PgPool) {
    let (store, actor, employee, receipt) = attested(&pool).await;
    assert!(
        scope_org(OrgId::one(), store.pending_self_binding_reviews(actor))
            .await
            .unwrap()
            .is_empty()
    );
    for (bound, permitted) in [(false, true), (true, false), (true, true)] {
        let checker = reviewer(&pool, actor, bound, permitted).await;
        let rows = scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
            .await
            .unwrap();
        if bound && permitted {
            assert_eq!(rows.len(), 1);
            assert_eq!((rows[0].id, rows[0].employee_id), (receipt, employee));
            let due: time::OffsetDateTime = sqlx::query_scalar(
                "SELECT review_due_at FROM account_link_self_attestations WHERE id=$1",
            )
            .bind(receipt)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(rows[0].due, due);
            sqlx::query(
                "UPDATE users SET person_id=(SELECT person_id FROM users WHERE id=$1) WHERE id=$2",
            )
            .bind(actor.as_uuid())
            .bind(checker.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
            assert!(
                scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
                    .await
                    .unwrap()
                    .is_empty()
            );
        } else {
            assert!(rows.is_empty());
        }
    }
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn review_inbox_removes_confirmed_revoked_and_replaced_bindings(pool: PgPool) {
    let (store, actor, _, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    assert_eq!(
        scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
            .await
            .unwrap()
            .len(),
        1
    );
    review(&store, checker, receipt, ReviewDecision::Confirm)
        .await
        .unwrap();
    assert!(
        scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
            .await
            .unwrap()
            .is_empty()
    );
    review(&store, checker, receipt, ReviewDecision::Revoke)
        .await
        .unwrap();
    assert!(
        scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
            .await
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn review_inbox_excludes_stale_bindings_and_revoked_permission(pool: PgPool) {
    let (store, actor, _, _) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    assert_eq!(
        scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
            .await
            .unwrap()
            .len(),
        1
    );
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$1 WHERE account_id=$2")
        .bind(actor.as_uuid()).bind(checker.as_uuid()).execute(&pool).await.unwrap();
    assert!(
        scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
            .await
            .unwrap()
            .is_empty()
    );
    let checker = reviewer(&pool, actor, true, true).await;
    assert_eq!(
        scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
            .await
            .unwrap()
            .len(),
        1
    );
    let replacement = employee(&pool).await;
    sqlx::query("UPDATE employees SET identity_review_required=false WHERE id=$1")
        .bind(replacement)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET employee_id=$2,person_id=console_bind_employee_person(org_id,$2,id) WHERE id=$1")
        .bind(actor.as_uuid()).bind(replacement).execute(&pool).await.unwrap();
    assert!(
        scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
            .await
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn review_inbox_query_count_stays_constant_at_two_thousand_employees(pool: PgPool) {
    let (_, actor, _, _) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    let logging_pool = PgPool::connect_with(
        pool.connect_options()
            .as_ref()
            .clone()
            .log_statements("Debug".parse().unwrap()),
    )
    .await
    .unwrap();
    let store = PgOrgStore::new(runtime_role_pool(&logging_pool).await);
    let before = query_count::QueryCount::default();
    let rows = scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
        .with_subscriber(before.clone())
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(before.get() > 0);
    sqlx::query("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) \
        SELECT $1,'Synthetic','Unrelated employee','fixture','fixture',n,gen_random_uuid()::text FROM generate_series(1,2000) n")
        .bind(OrgId::one().as_uuid()).execute(&pool).await.unwrap();
    let after = query_count::QueryCount::default();
    let start = std::time::Instant::now();
    let rows = scope_org(OrgId::one(), store.pending_self_binding_reviews(checker))
        .with_subscriber(after.clone())
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(after.get(), before.get());
    println!(
        "review inbox: {} queries at 2000 employees in {:?}",
        after.get(),
        start.elapsed()
    );
}
