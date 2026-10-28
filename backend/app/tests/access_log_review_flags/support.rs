// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use super::statements::Statements;
use console_kernel_core::{OrgId, UserId};
use console_platform_access::log_review::list::{page_in_tx, prepare_in_tx};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use std::time::Instant;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::util::SubscriberInitExt;
use uuid::Uuid;

pub async fn arm(pool: &PgPool, org: OrgId) -> Transaction<'static, Postgres> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx
}

pub async fn policy(pool: &PgPool, org: OrgId, user: UserId, suffix: &str, value: i64) {
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code,effective_from) VALUES($1,$2,$3,$4,'POLICY_REVIEW',clock_timestamp())")
        .bind(org.as_uuid()).bind(format!("access_log_review.flag.{suffix}")).bind(json!(value)).bind(user.as_uuid()).execute(pool).await.unwrap();
}

pub async fn event(
    pool: &PgPool,
    org: OrgId,
    user: UserId,
    action: &str,
    occurred: &str,
    detail: Value,
) -> Uuid {
    let mut after = json!({"self_read":false,"subject_count":0});
    after
        .as_object_mut()
        .unwrap()
        .extend(detail.as_object().unwrap().clone());
    sqlx::query_scalar("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap,outcome) VALUES($1,$2,$3,'employee','test',repeat('a',32),repeat('b',16),$4::text::timestamptz,'2026-09-10T00:00:00Z',$5,$6) RETURNING id")
        .bind(org.as_uuid()).bind(user.as_uuid()).bind(action).bind(occurred).bind(&after).bind(if detail["denied"] == true {"DENIED"} else {"ALLOWED"}).fetch_one(pool).await.unwrap()
}

pub async fn performance(pool: PgPool, sparse: bool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "perf").await;
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) SELECT md5('actor-'||n)::uuid,$1,'Actor '||n,'{}' FROM generate_series(1,2000) n")
        .bind(org.as_uuid()).execute(&pool).await.unwrap();
    let small_org = OrgId::new();
    let small_user = seed_org_and_super_admin(&pool, *small_org.as_uuid(), "ten").await;
    for _ in 0..10 {
        event(
            &pool,
            small_org,
            small_user,
            "employee.read",
            "2026-09-01T02:00:00Z",
            json!({}),
        )
        .await;
    }
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap,outcome) SELECT $1,md5('actor-'||((n-1)%2000+1))::uuid,CASE WHEN $2 AND n%100000=0 THEN 'employee.rrn_reveal' ELSE 'employee.read' END,'employee','test',repeat('a',32),repeat('b',16),CASE WHEN $2 THEN '2026-09-01T02:00:00Z'::timestamptz ELSE '2026-09-01T00:00:00Z'::timestamptz+((n*7919)%2592000)*interval '1 second' END,'2026-09-01T00:00:00Z'::timestamptz+n*interval '1 second','{\"self_read\":false,\"subject_count\":1}'::jsonb,'ALLOWED' FROM generate_series(1,200000) n")
        .bind(org.as_uuid()).bind(sparse).execute(&pool).await.unwrap();
    sqlx::query("ANALYZE audit_events")
        .execute(&pool)
        .await
        .unwrap();
    tracing_subscriber::registry().try_init().ok();
    let rt = runtime_role_pool(&pool).await;
    let statements = Statements::default();
    let dispatch = statements.dispatch();
    let mut small_tx = arm(&rt, small_org).await;
    let small = prepare_in_tx(small_tx.as_mut(), small_org, "2026-09")
        .with_subscriber(dispatch.clone())
        .await
        .unwrap();
    let small_preparation = statements.take();
    page_in_tx(small_tx.as_mut(), &small, None, 50, true)
        .with_subscriber(dispatch.clone())
        .await
        .unwrap();
    assert_eq!(small.totals()["flagged"], 0);
    let small_statements = statements.take();
    page_in_tx(small_tx.as_mut(), &small, None, 50, false)
        .with_subscriber(dispatch.clone())
        .await
        .unwrap();
    let small_all_statements = statements.take();
    assert!(!small_all_statements.is_empty(), "instrument real SQL");
    small_tx.commit().await.unwrap();
    let mut tx = arm(&rt, org).await;
    let start = Instant::now();
    let snapshot = prepare_in_tx(tx.as_mut(), org, "2026-09")
        .with_subscriber(dispatch.clone())
        .await
        .unwrap();
    let large_preparation = statements.take();
    assert_eq!(small_preparation.len(), large_preparation.len());
    eprintln!(
        "statements/preparation={} at 10 and 200000 rows",
        large_preparation.len()
    );
    // Prove that paging uses serializable evidence, ready for the review-start writer.
    let snapshot: console_platform_access::log_review::list::Prepared =
        serde_json::from_value(serde_json::to_value(snapshot).unwrap()).unwrap();
    eprintln!(
        "200000 rows, 2000 actors; one-time preparation {:?}; snapshot {} bytes",
        start.elapsed(),
        serde_json::to_vec(&snapshot).unwrap().len()
    );
    assert_eq!(snapshot.totals()["events"], 200000);
    page_in_tx(tx.as_mut(), &snapshot, None, 50, true)
        .with_subscriber(dispatch.clone())
        .await
        .unwrap();
    let large_statements = statements.take();
    assert_eq!(small_statements.len(), large_statements.len());
    page_in_tx(tx.as_mut(), &snapshot, None, 50, false)
        .with_subscriber(dispatch)
        .await
        .unwrap();
    let large_all_statements = statements.take();
    assert_eq!(small_all_statements.len(), large_all_statements.len());
    eprintln!(
        "sparse={sparse}; statements/page flagged={} all={} at 10 and 200000 rows",
        large_statements.len(),
        large_all_statements.len()
    );
    if sparse {
        assert_eq!(snapshot.totals()["flagged"], 2);
    }
    for flagged in [true, false] {
        let mut times = Vec::new();
        let mut cursor = None;
        for _ in 0..20 {
            let start = Instant::now();
            let rows = page_in_tx(tx.as_mut(), &snapshot, cursor, 50, flagged)
                .await
                .unwrap();
            times.push(start.elapsed().as_micros());
            cursor = rows.last().map(|last| (last.created_at, last.event_id));
        }
        times.sort_unstable();
        eprintln!(
            "sparse={sparse}; flagged={flagged}; page p95={}µs; samples={times:?}",
            times[18]
        );
        assert!(times[18] <= 300_000, "page p95 exceeds 300ms: {times:?}");
    }
    let data = serde_json::to_value(&snapshot).unwrap();
    let sql = large_all_statements
        .iter()
        .find(|s| s.contains("SELECT id AS event_id"))
        .expect("capture the actual page statement");
    // Only the SQL just executed by the production builder is reused; all inputs remain bound.
    let mut explain = sqlx::QueryBuilder::new("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ");
    explain.push(sql.as_str());
    let plan: Value = explain
        .build_query_scalar()
        .bind(org.as_uuid())
        .bind(
            time::OffsetDateTime::parse(
                data["from"].as_str().unwrap(),
                &time::format_description::well_known::Rfc3339,
            )
            .unwrap(),
        )
        .bind(
            time::OffsetDateTime::parse(
                data["to"].as_str().unwrap(),
                &time::format_description::well_known::Rfc3339,
            )
            .unwrap(),
        )
        .bind(None::<time::OffsetDateTime>)
        .bind(None::<Uuid>)
        .bind(50_i64)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    let rendered = serde_json::to_string_pretty(&plan).unwrap();
    assert!(has_cursor_index_scan(&plan), "{rendered}");
    if let Ok(path) = std::env::var("ACCESS_LOG_REVIEW_EXPLAIN") {
        std::fs::write(path, &rendered).unwrap();
    }
    eprintln!("EXPLAIN confirms Index Scan on idx_audit_events_org_seal_cursor");
    tx.commit().await.unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let service = console_platform_access::AccessService::new(rt, None);
    let principal = console_platform_authz::Principal::new(
        user,
        org,
        Default::default(),
        console_kernel_core::BranchScope::All,
    );
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
        .bind(small_org.as_uuid())
        .bind(small_user.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let small_principal = console_platform_authz::Principal::new(
        small_user,
        small_org,
        Default::default(),
        console_kernel_core::BranchScope::All,
    );
    console_platform_access::log_review::record::start(
        &service,
        small_principal.clone(),
        "2026-09".into(),
        "small-start-test-key".into(),
    )
    .await
    .unwrap();
    console_platform_access::log_review::record::start(
        &service,
        principal.clone(),
        "2026-09".into(),
        "dense-start-test-key".into(),
    )
    .await
    .unwrap();
    let (raw, stored): (i32, i32) = sqlx::query_as("SELECT octet_length(after_snap::text),pg_column_size(after_snap) FROM audit_events WHERE org_id=$1 AND action='access_log_review.start'")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    eprintln!("frozen evidence sparse={sparse}: raw={raw} TOAST={stored} bytes");
    assert!(raw < 32 * 1024 * 1024, "dense JSON budget: {raw}");
    assert!(stored < 8 * 1024 * 1024, "dense TOAST budget: {stored}");
    let reads = Statements::default();
    let dispatch = reads.dispatch();
    console_platform_access::log_review::record::frozen_page(
        &service,
        small_principal,
        "2026-09".into(),
        None,
        50,
    )
    .with_subscriber(dispatch.clone())
    .await
    .unwrap();
    let small_count = reads.take().len();
    console_platform_access::log_review::record::frozen_page(
        &service,
        principal.clone(),
        "2026-09".into(),
        None,
        50,
    )
    .with_subscriber(dispatch)
    .await
    .unwrap();
    let large_count = reads.take().len();
    assert!(small_count > 0);
    assert_eq!(small_count, large_count);
    eprintln!("persisted statements/request={large_count} at 10 and 200000 rows");
    let mut times = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let page = console_platform_access::log_review::record::frozen_page(
            &service,
            principal.clone(),
            "2026-09".into(),
            None,
            50,
        )
        .await
        .unwrap();
        assert_eq!(page.len(), if sparse { 2 } else { 50 });
        times.push(start.elapsed().as_millis());
    }
    times.sort_unstable();
    eprintln!(
        "persisted frozen page sparse={sparse}: p95={}ms; samples={times:?}",
        times[18]
    );
    assert!(
        times[18] <= 300,
        "persisted page p95 exceeds 300ms: {times:?}"
    );
}

fn has_cursor_index_scan(value: &Value) -> bool {
    match value {
        Value::Object(fields) => {
            (fields.get("Node Type") == Some(&json!("Index Scan"))
                && fields.get("Index Name") == Some(&json!("idx_audit_events_org_seal_cursor")))
                || fields.values().any(has_cursor_index_scan)
        }
        Value::Array(items) => items.iter().any(has_cursor_index_scan),
        _ => false,
    }
}
