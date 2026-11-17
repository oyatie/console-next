// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/lifecycle_grant.rs"]
mod lifecycle_grant;
#[allow(dead_code)]
#[path = "support/trail_queries.rs"]
mod trail_queries;

use console_hr_adapter_postgres::{HrError, clock::today_kst};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

async fn people(pool: &PgPool) -> (fixture::Fixture, Vec<Uuid>) {
    // Keep SQLx debug callsites enabled while parallel per-future subscribers drop.
    static SQL_TRACING: OnceLock<tracing::Dispatch> = OnceLock::new();
    SQL_TRACING.get_or_init(|| tracing::Dispatch::new(trail_queries::Queries::default()));
    let f = fixture::fixture(pool.clone()).await;
    lifecycle_grant::grant(
        pool,
        *f.principal.org_id.as_uuid(),
        *f.principal.user_id.as_uuid(),
    )
    .await;
    let mut ids = Vec::new();
    for n in 0..3 {
        let mut body = f.body(&format!("own-record-{n}"), "REGULAR");
        body.name = format!("합성 직원 {n}");
        body.hire_date = Some(today_kst().to_string());
        ids.push(f.create(body).await.unwrap().employee_id());
    }
    (f, ids)
}

async fn appoint(f: &fixture::Fixture, ids: &[Uuid], job: &str) -> (Result<Value, HrError>, usize) {
    let queries = trail_queries::Queries::default();
    let result =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            Uuid::new_v4().to_string(),
            serde_json::from_value(json!({"event_type":"APPOINT","employee_ids":ids,
            "to_job":job,"effective_date":today_kst().to_string(),"comment":"직무 발령"}))
            .unwrap(),
        )
        .with_subscriber(queries.clone())
        .await;
    let reads = queries
        .statements()
        .iter()
        .filter(|sql| sql.contains("AS is_self"))
        .count();
    (result, reads)
}

async fn nothing_written(pool: &PgPool, ids: &[Uuid]) {
    let changed: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employees WHERE id=ANY($1) AND job='개발'")
            .bind(ids)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(
        changed, 0,
        "a self-record refusal rolls back every employee"
    );
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM employee_lifecycle_events WHERE employee_id=ANY($1) AND event_type='APPOINT'")
        .bind(ids).fetch_one(pool).await.unwrap();
    assert_eq!(events, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bulk_action_loads_self_record_facts_once(pool: PgPool) {
    let (f, ids) = people(&pool).await;
    let (result, reads) = appoint(&f, &ids, "개발").await;
    assert_eq!(
        result.unwrap()["items"].as_array().unwrap().len(),
        ids.len()
    );
    assert_eq!(reads, 1, "one own-record fact load for the entire batch");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bulk_action_refuses_self_and_same_person_before_any_writes(pool: PgPool) {
    let (f, ids) = people(&pool).await;
    sqlx::query("UPDATE users SET employee_id=$2 WHERE id=$1")
        .bind(f.principal.user_id.as_uuid())
        .bind(ids[2])
        .execute(&pool)
        .await
        .unwrap();
    for same_person in [false, true] {
        let selected = if same_person { &ids[..2] } else { &ids[..] };
        if same_person {
            sqlx::query("WITH old AS (DELETE FROM employee_person_bindings WHERE employee_id=$1 RETURNING *) \
                INSERT INTO employee_person_bindings(org_id,employee_id,person_id,actor_id,payload_digest) \
                SELECT org_id,employee_id,$2,actor_id,payload_digest FROM old")
                .bind(ids[1])
                .bind(ids[2])
                .execute(&pool)
                .await
                .unwrap();
        }
        let (result, reads) = appoint(&f, selected, "개발").await;
        let error = result.unwrap_err();
        assert_eq!(
            (error.status.as_u16(), error.code),
            (403, "own_record_forbidden")
        );
        assert_eq!(
            error.refusals.unwrap()[0]["remedy"],
            "another_holder_or_ops"
        );
        nothing_written(&pool, &ids).await;
        assert_eq!(reads, 1, "self-record checks are batched even on refusal");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bulk_ops_self_write_keeps_break_glass_audit_and_live_holder_refusal(pool: PgPool) {
    let (mut f, ids) = people(&pool).await;
    sqlx::query("UPDATE users SET employee_id=$2,is_tenant_ops=true WHERE id=$1")
        .bind(f.principal.user_id.as_uuid())
        .bind(ids[2])
        .execute(&pool)
        .await
        .unwrap();
    f.principal = f.principal.with_tenant_ops(true);
    let (result, reads) = appoint(&f, &ids, "개발").await;
    result.unwrap();
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='authz.own_record.break_glass' AND target_id=$2 AND (after_snap->>'review_required')::bool")
        .bind(f.principal.org_id.as_uuid()).bind(ids[2].to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(
        audits, 1,
        "only the own record needs a review-flagged audit"
    );
    let colleague = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES ($1,$2,'동료','{}')")
        .bind(colleague)
        .bind(f.principal.org_id.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    lifecycle_grant::grant_hr_basic(
        &pool,
        *f.principal.org_id.as_uuid(),
        colleague,
        &["view", "edit"],
    )
    .await;
    let (result, refused_reads) = appoint(&f, &ids, "검토").await;
    let error = result.unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (403, "own_record_forbidden")
    );
    let refused_events: i64 = sqlx::query_scalar("SELECT count(*) FROM employee_lifecycle_events WHERE employee_id=ANY($1) AND to_job='검토'")
        .bind(&ids).fetch_one(&pool).await.unwrap();
    assert_eq!(
        refused_events, 0,
        "a new holder prevents every write in the batch"
    );
    assert_eq!((reads, refused_reads), (1, 1));
}
