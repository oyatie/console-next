// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{grant_op, world};

const PATH: &str = "/api/v1/access/access-log?period=2026-09";

async fn seed(w: &support::World, n: i32) {
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap,outcome,ip) SELECT $1,$2,CASE WHEN n%2=0 THEN 'employee.rrn_reveal' ELSE 'employee.read' END,'employee','test',repeat('a',32),repeat('b',16),'2026-09-01T02:00:00Z','2026-09-10T00:00:00Z','{\"self_read\":false,\"subject_count\":1}'::jsonb,'ALLOWED','203.0.113.9' FROM generate_series(1,$3) n")
        .bind(w.org).bind(w.hr.as_uuid()).bind(n).execute(&w.owner).await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn access_log_pages_two_thousand_tied_rows_with_totals_and_tenant_isolation(pool: PgPool) {
    let w = world(pool.clone()).await;
    seed(&w, 2000).await;
    let other = world(pool).await;
    seed(&other, 1).await;
    let (status, warm) = w
        .call(Method::GET, &format!("{PATH}&limit=1"), w.ops, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{warm}");
    let started = std::time::Instant::now();
    let (status, first) = w
        .call(Method::GET, &format!("{PATH}&limit=200"), w.ops, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert!(
        started.elapsed().as_secs_f64() < 2.0,
        "warmed request: {:?}",
        started.elapsed()
    );
    assert_eq!(first["totals"]["events"], 2000);
    assert_eq!(first["totals"]["flagged"], 1000);
    assert_eq!(first["totals"]["by_flag"]["sensitive_read"], 1000);
    assert_eq!(first["period"]["closed"], true);
    assert_eq!(first["period"]["time_zone"], "Asia/Seoul");
    assert_eq!(first["period"]["from"], "2026-09-01");
    assert_eq!(first["period"]["to"], "2026-10-01");
    let item = &first["items"][0];
    assert_eq!(item["actor_id"], w.hr.to_string());
    assert_eq!(item["actor_name"], "김인사");
    assert_eq!(item["subject_count"], 1);
    assert_eq!(item["ip"], "203.0.113.9");
    assert!(item.get("after_snap").is_none());
    let mut ids = Vec::new();
    let mut page = first;
    loop {
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
        let (status, next) = w
            .call(
                Method::GET,
                &format!("{PATH}&limit=200&cursor={cursor}"),
                w.ops,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{next}");
        page = next;
    }
    assert_eq!(ids.len(), 2000);
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 2000);
    let (_, flagged) = w
        .call(
            Method::GET,
            &format!("{PATH}&flagged=true&limit=200"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(flagged["totals"]["events"], 2000);
    assert_eq!(flagged["items"].as_array().unwrap().len(), 200);
    assert!(
        flagged["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["flags"] == json!(["sensitive_read"]))
    );
    let reads: Vec<Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='access_log.review_read'",
    )
    .bind(w.org)
    .fetch_all(&w.owner)
    .await
    .unwrap();
    assert_eq!(reads.len(), 12);
    assert!(reads.iter().all(|r| r["subject_ids"] == json!([w.hr])));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn access_log_refuses_invalid_period_limit_and_cursor_without_access_record(pool: PgPool) {
    let w = world(pool).await;
    for (query, code) in [
        ("period=2026-9", "period_invalid"),
        ("period=2026-13", "period_invalid"),
        ("period=9999-12", "period_invalid"),
        ("period=2026-09&limit=0", "limit_out_of_range"),
        ("period=2026-09&limit=201", "limit_out_of_range"),
        ("period=2026-09&cursor=garbage", "cursor_invalid"),
        (
            "period=2026-09&cursor=2026-08~false~0~00000000-0000-0000-0000-000000000000",
            "cursor_invalid",
        ),
    ] {
        let (status, body) = w
            .call(
                Method::GET,
                &format!("/api/v1/access/access-log?{query}"),
                w.ops,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{query}: {body}");
        assert_eq!(body["error"]["code"], code);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log.review_read'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(count, 0);
    let (_, empty) = w.call(Method::GET, PATH, w.ops, None).await;
    assert_eq!(empty["items"], json!([]));
    assert!(empty["next_cursor"].is_null());
    assert_eq!(empty["totals"]["events"], 0);
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap) VALUES($1,$2,'employee.export_refused','employee','test',repeat('a',32),repeat('b',16),'2026-09-01T02:00:00Z','2026-09-10T00:00:00Z','{\"self_read\":false,\"subject_count\":0}'::jsonb)")
        .bind(w.org).bind(w.hr.as_uuid()).execute(&w.owner).await.unwrap();
    let (status, legacy) = w.call(Method::GET, PATH, w.ops, None).await;
    assert_eq!(status, StatusCode::OK, "{legacy}");
    assert_eq!(legacy["items"][0]["outcome"], "DENIED");
    assert_eq!(legacy["items"][0]["principal_type"], "");
    let month: String =
        sqlx::query_scalar("SELECT to_char(now() AT TIME ZONE 'Asia/Seoul','YYYY-MM')")
            .fetch_one(&w.owner)
            .await
            .unwrap();
    let (status, open) = w
        .call(
            Method::GET,
            &format!("/api/v1/access/access-log?period={month}"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{open}");
    assert_eq!(open["period"]["closed"], false);
    let (status, default) = w
        .call(Method::GET, "/api/v1/access/access-log", w.ops, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{default}");
    assert_eq!(default["period"], open["period"]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn access_log_current_month_paging_does_not_chase_its_own_read_records(pool: PgPool) {
    let w = world(pool).await;
    for _ in 0..2 {
        assert_eq!(
            w.call(Method::GET, "/api/v1/access/access-log", w.ops, None)
                .await
                .0,
            StatusCode::OK
        );
    }
    let (_, first) = w
        .call(
            Method::GET,
            "/api/v1/access/access-log?limit=1",
            w.ops,
            None,
        )
        .await;
    assert_eq!(first["totals"]["events"], 2);
    let cursor = first["next_cursor"].as_str().unwrap();
    let (status, last) = w
        .call(
            Method::GET,
            &format!("/api/v1/access/access-log?limit=1&cursor={cursor}"),
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{last}");
    assert_eq!(last["totals"], first["totals"]);
    assert_eq!(last["items"].as_array().unwrap().len(), 1);
    assert!(last["next_cursor"].is_null(), "{last}");
    for path in [
        format!(
            "/api/v1/access/access-log?cursor={}",
            cursor.replace(&w.org.to_string(), &uuid::Uuid::new_v4().to_string())
        ),
        format!("{PATH}&cursor={cursor}"),
        format!("/api/v1/access/access-log?flagged=true&cursor={cursor}"),
    ] {
        let (status, body) = w.call(Method::GET, &path, w.ops, None).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], "cursor_invalid");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn access_log_returns_no_personal_records_when_read_audit_cannot_commit(pool: PgPool) {
    let w = world(pool).await;
    seed(&w, 1).await;
    sqlx::raw_sql("CREATE FUNCTION refuse_log_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='access_log.review_read' THEN RAISE EXCEPTION 'read audit refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_log_read BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_log_read()")
        .execute(&w.owner).await.unwrap();
    let (status, body) = w.call(Method::GET, PATH, w.ops, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body.get("items").is_none());
    assert!(!body.to_string().contains("김인사"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn access_log_requires_live_cedar_audit_view_over_the_whole_tenant(pool: PgPool) {
    let mut w = world(pool).await;
    let (status, body) = w.call(Method::GET, PATH, w.hr, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "access_denied");
    let role = w
        .role("감사 조회", json!([{"domain":"audit","levels":["view"]}]))
        .await;
    w.grant(json!([grant_op(
        w.hr,
        role,
        "LEGAL_ENTITY",
        Some(w.le_a),
        true
    )]))
    .await;
    let (status, body) = w.call(Method::GET, PATH, w.hr, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "scope_tenant_wide_only");
    w.grant(json!([grant_op(w.hr, role, "TENANT", None, true)]))
        .await;
    let (status, body) = w.call(Method::GET, PATH, w.hr, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE org_id=$1",
    )
    .bind(w.org)
    .bind(w.ops.as_uuid())
    .execute(&w.owner)
    .await
    .unwrap();
    let (status, body) = w.call(Method::GET, PATH, w.hr, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "access_denied");
}
