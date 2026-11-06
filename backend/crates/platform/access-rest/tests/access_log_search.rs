// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::world;

const PATH: &str = "/api/v1/access/access-log?period=2026-09";

async fn seed(w: &support::World, n: i32) {
    sqlx::query("INSERT INTO audit_events(org_id,actor,actor_display,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap,outcome,ip) SELECT $1,CASE WHEN n%2=0 THEN $2 ELSE $3 END,CASE WHEN n%2=0 THEN NULL ELSE 'Historical Actor' END,CASE WHEN n%2=0 THEN 'employee.rrn_reveal' ELSE 'employee.read' END,'employee','test',repeat('a',32),repeat('b',16),'2026-09-01T02:00:00Z','2026-09-10T00:00:00Z',CASE WHEN n%2=0 THEN '{\"self_read\":false,\"subject_count\":777,\"private_note\":\"hidden-needle\"}' ELSE '{\"self_read\":false,\"subject_count\":1,\"export_purpose\":\"payroll_%\\\\archive\"}' END::jsonb,CASE WHEN n%2=0 THEN 'DENIED' ELSE 'ALLOWED' END,CASE WHEN n%2=0 THEN '203.0.113.9' ELSE '198.51.100.7' END FROM generate_series(1,$4) n")
        .bind(w.org).bind(w.hr.as_uuid()).bind(w.hr2.as_uuid()).bind(n).execute(&w.owner).await.unwrap();
}

async fn get(w: &support::World, suffix: &str) -> Value {
    let (status, body) = w
        .call(Method::GET, &format!("{PATH}{suffix}"), w.ops, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{suffix}: {body}");
    body
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn search_filters_projected_fields_totals_and_audits_only_returned_actors(pool: PgPool) {
    let w = world(pool.clone()).await;
    seed(&w, 4).await;
    let other = world(pool).await;
    seed(&other, 2).await;
    for term in [
        "김인사".to_owned(),
        w.hr.to_string(),
        "203.0.113".into(),
        "RRN_REVEAL".into(),
        "DENIED".into(),
        "sensitive_read".into(),
        "777".into(),
    ] {
        let encoded: String = term.bytes().map(|b| format!("%{b:02X}")).collect();
        let body = get(&w, &format!("&search={encoded}")).await;
        assert_eq!(body["items"].as_array().unwrap().len(), 2, "{term}: {body}");
        assert_eq!(body["totals"]["events"], 2, "{term}: {body}");
        assert_eq!(body["totals"]["flagged"], 2);
        assert_eq!(body["totals"]["by_flag"]["sensitive_read"], 2);
        assert!(
            body["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["actor_id"] == w.hr.to_string())
        );
    }
    for term in ["historical", "payroll_%\\archive"] {
        let encoded: String = term.bytes().map(|b| format!("%{b:02X}")).collect();
        let body = get(&w, &format!("&search={encoded}")).await;
        assert_eq!(body["totals"]["events"], 2, "{term}: {body}");
        assert!(
            body["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["actor_name"] == "Historical Actor")
        );
    }
    for term in [
        "missing",
        "hidden-needle",
        "%27%20OR%20true--",
        "%25%25%25",
        "%5F%5F%5F",
    ] {
        let body = get(&w, &format!("&search={term}")).await;
        assert_eq!(body["items"], json!([]), "{term}: {body}");
        assert_eq!(body["totals"]["events"], 0);
        assert_eq!(body["totals"]["flagged"], 0);
        assert!(body["next_cursor"].is_null());
    }
    for suffix in [
        "&search=",
        "&search=%20%20",
        "&search=employee",
        "&search=2026-09-01",
        "&search=2026-09-10",
    ] {
        assert_eq!(get(&w, suffix).await["totals"]["events"], 4);
    }
    assert_eq!(
        get(&w, "&search=historical&flagged=true").await["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        get(&w, "&search=DENIED&flagged=true").await["totals"]["events"],
        2
    );
    let reads: Vec<Value> = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='access_log.review_read' ORDER BY created_at,id")
        .bind(w.org).fetch_all(&w.owner).await.unwrap();
    assert_eq!(reads.len(), 21);
    for row in &reads[..7] {
        assert_eq!(row["subject_ids"], json!([w.hr]));
        assert_eq!(row["rows"], 2);
        assert!(!row.to_string().contains("search"));
    }
    for row in &reads[9..14] {
        assert_eq!(row["subject_ids"], json!([]));
        assert_eq!(row["rows"], 0);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn search_classifies_actor_day_patterns_before_filtering(pool: PgPool) {
    let w = world(pool).await;
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap,outcome,ip) SELECT $1,$2,'employee.export','employee','test',repeat('a',32),repeat('b',16),'2026-09-01T02:00:00Z','2026-09-10T00:00:00Z','{\"self_read\":false,\"subject_count\":1,\"export_purpose\":\"payroll\"}'::jsonb,'ALLOWED','203.0.113.'||n FROM generate_series(1,3) n")
        .bind(w.org).bind(w.hr.as_uuid()).execute(&w.owner).await.unwrap();
    let page = get(&w, "&search=203.0.113.1&flagged=true").await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["totals"]["events"], 1);
    assert_eq!(page["totals"]["by_flag"]["download_repeat"], 1);
    assert!(
        page["items"][0]["flags"]
            .as_array()
            .unwrap()
            .contains(&json!("download_repeat"))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn search_keysets_page_tied_rows_and_refuse_other_searches_without_a_read_record(
    pool: PgPool,
) {
    let w = world(pool).await;
    seed(&w, 2000).await;
    let first = get(&w, "&search=rrn_REVEAL&limit=200").await;
    assert_eq!(first["totals"]["events"], 1000);
    let cursor = first["next_cursor"].as_str().unwrap();
    let reads_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log.review_read'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    for search in [
        "",
        "&search=historical",
        "&search=rrn",
        "&search=rrn_reveal~",
    ] {
        let (status, body) = w
            .call(
                Method::GET,
                &format!("{PATH}{search}&cursor={cursor}"),
                w.ops,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{search}: {body}");
        assert_eq!(body["error"]["code"], "cursor_invalid");
    }
    let reads_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log.review_read'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(reads_before, reads_after);
    let mut page = first;
    let mut ids = Vec::new();
    loop {
        assert_eq!(page["totals"]["events"], 1000);
        ids.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["event_id"].as_str().unwrap().to_owned()),
        );
        let Some(cursor) = page["next_cursor"].as_str() else {
            break;
        };
        page = get(
            &w,
            &format!("&search=%20RRN_reveal%20&limit=200&cursor={cursor}"),
        )
        .await;
    }
    assert_eq!(ids.len(), 1000);
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 1000);
    let unfiltered = get(&w, "&limit=1").await;
    let cursor = unfiltered["next_cursor"].as_str().unwrap();
    let (status, body) = w
        .call(
            Method::GET,
            &format!("{PATH}&search=rrn_reveal&cursor={cursor}"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "cursor_invalid");
    assert_search_plan(&w).await;
}

async fn assert_search_plan(w: &support::World) {
    sqlx::query("INSERT INTO users(org_id,id,display_name,roles) SELECT $1,gen_random_uuid(),'Account '||n,'{}' FROM generate_series(1,1997) n")
        .bind(w.org).execute(&w.owner).await.unwrap();
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap,ip) SELECT $1,u.id,'employee.read','employee','test',repeat('a',32),repeat('b',16),m,m,'{\"self_read\":false,\"subject_count\":1}'::jsonb,'203.0.113.9' FROM users u CROSS JOIN generate_series('2026-01-01'::timestamptz,'2026-12-01'::timestamptz,interval '1 month') m WHERE u.org_id=$1")
        .bind(w.org).execute(&w.owner).await.unwrap();
    sqlx::raw_sql("ANALYZE audit_events; ANALYZE users; ANALYZE person_revisions")
        .execute(&w.owner)
        .await
        .unwrap();
    let mut tx = w.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(w.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    for term in ["김인사", "203.0.113", "no-match", "employee.read", "%"] {
        let mut sql = sqlx::QueryBuilder::new("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ");
        sql.push(include_str!("../../access/src/log_review/search.sql"));
        let plan: Value = sql
            .build_query_scalar()
            .bind(w.org)
            .bind(time::macros::datetime!(2026-08-31 15:00 UTC))
            .bind(time::macros::datetime!(2026-09-30 15:00 UTC))
            .bind(time::macros::datetime!(2026-11-01 0:00 UTC))
            .bind(term)
            .bind(Vec::<uuid::Uuid>::new())
            .bind("Asia/Seoul")
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
        let rendered = serde_json::to_string_pretty(&plan).unwrap();
        assert!(!rendered.contains("Seq Scan"), "{term}: {rendered}");
        assert!(rendered.contains("Index"), "{term}: {rendered}");
        eprintln!("search={term}: {rendered}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn search_preserves_cedar_refusals_and_returns_nothing_if_read_audit_fails(pool: PgPool) {
    let w = world(pool).await;
    seed(&w, 2).await;
    assert_eq!(get(&w, "&search=historical").await["totals"]["events"], 1);
    let (status, body) = w
        .call(
            Method::GET,
            &format!("{PATH}&search=historical"),
            w.hr,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "access_denied");
    sqlx::raw_sql("CREATE FUNCTION refuse_log_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='access_log.review_read' THEN RAISE EXCEPTION 'read audit refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_log_read BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_log_read()")
        .execute(&w.owner).await.unwrap();
    let (status, body) = w
        .call(
            Method::GET,
            &format!("{PATH}&search=historical"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body.get("items").is_none());
    assert!(!body.to_string().contains("Historical Actor"));
}
