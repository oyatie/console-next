// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{grant_op, world};

const PATH: &str = "/api/v1/access/access-log?period=2026-09";

async fn seed(w: &support::World) {
    sqlx::query("INSERT INTO audit_events(org_id,actor,actor_display,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap) SELECT $1,CASE WHEN n=4 THEN $3 ELSE $2 END,CASE WHEN n=7 THEN NULL ELSE 'Historical Actor' END,CASE WHEN n=3 THEN 'employee.rrn_reveal' ELSE 'employee.export' END,CASE WHEN n=5 THEN 'user' ELSE 'employee' END,'test',repeat('a',32),repeat('b',16),'2026-09-10T02:00:00Z',at,'{\"self_read\":false,\"subject_count\":1,\"export_purpose\":\"payroll\"}'::jsonb FROM unnest(ARRAY['2026-09-09T14:59:59.999999Z','2026-09-09T15:00:00Z','2026-09-10T14:59:59.999999Z','2026-09-10T02:00:00Z','2026-09-10T03:00:00Z','2026-09-10T15:00:00Z','2026-09-11T02:00:00Z']::timestamptz[]) WITH ORDINALITY t(at,n)")
        .bind(w.org).bind(w.hr.as_uuid()).bind(w.hr2.as_uuid()).execute(&w.owner).await.unwrap();
}

async fn get(w: &support::World, suffix: &str) -> Value {
    let (status, body) = w
        .call(Method::GET, &format!("{PATH}{suffix}"), w.ops, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{suffix}: {body}");
    body
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn filters_intersect_totals_and_keep_month_options_private_and_stable(pool: PgPool) {
    let w = world(pool.clone()).await;
    let other = world(pool).await;
    seed(&w).await;
    seed(&other).await;
    let all = get(&w, "").await;
    let options = &all["filter_options"];
    assert_eq!(options["actors"].as_array().unwrap().len(), 2);
    for actor in [w.hr, w.hr2] {
        assert!(
            options["actors"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["id"] == actor.to_string()
                    && v["label"].as_str().unwrap().contains("Historical Actor")
                    && v["label"].as_str().unwrap().contains(&actor.to_string()))
        );
    }
    assert_eq!(
        options["actions"],
        json!([
            {"id":"employee.export","label_key":"accessLog.action.employee.export"},
            {"id":"employee.rrn_reveal","label_key":"accessLog.action.employee.rrn_reveal"}
        ])
    );
    assert_eq!(
        options["target_types"],
        json!([
            {"id":"employee","label_key":"accessLog.target.employee"},
            {"id":"user","label_key":"accessLog.target.user"}
        ])
    );
    let suffix = format!(
        "&actor={}&action=employee.export&target_type=employee&from=2026-09-10&to=2026-09-10",
        w.hr
    );
    let filtered = get(&w, &suffix).await;
    assert_eq!(filtered["totals"]["events"], 1);
    assert_eq!(
        filtered["totals"]["by_flag"]["download_repeat"], 1,
        "flags must use the full actor-day before filters"
    );
    assert_eq!(filtered["items"][0]["actor_id"], w.hr.to_string());
    assert_eq!(&filtered["filter_options"], options);
    let empty = get(&w, &format!("{suffix}&search=nonexistent")).await;
    assert_eq!(empty["items"], json!([]));
    assert_eq!(empty["totals"]["events"], 0);
    assert_eq!(&empty["filter_options"], options);
    let date_only = get(&w, "&from=2026-09-10&to=2026-09-10").await;
    assert_eq!(date_only["totals"]["events"], 4);
    let reads: Vec<Value> = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='access_log.review_read' ORDER BY created_at,id")
        .bind(w.org).fetch_all(&w.owner).await.unwrap();
    let mut actors = vec![w.hr, w.hr2];
    actors.sort();
    assert_eq!(reads[1]["subject_ids"], json!(actors));
    assert_eq!(reads[2]["subject_ids"], json!(actors));
    assert!(!options.to_string().contains(&other.hr.to_string()));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn filters_page_tied_rows_and_bind_every_parameter_to_the_cursor(pool: PgPool) {
    let w = world(pool).await;
    seed(&w).await;
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap) SELECT $1,$2,'employee.export','employee','test',repeat('a',32),repeat('b',16),'2026-09-10T02:00:00Z','2026-09-10T02:00:00Z','{\"self_read\":false,\"subject_count\":1}'::jsonb FROM generate_series(1,7)")
        .bind(w.org).bind(w.hr.as_uuid()).execute(&w.owner).await.unwrap();
    let params = [
        format!("actor={}", w.hr),
        "action=employee.export".into(),
        "target_type=employee".into(),
        "from=2026-09-10".into(),
        "to=2026-09-10".into(),
    ];
    let suffix = format!("&{}&limit=2", params.join("&"));
    let mut page = get(&w, &suffix).await;
    assert_eq!(page["totals"]["events"], 8);
    let first_options = page["filter_options"].clone();
    let cursor = page["next_cursor"].as_str().unwrap();
    for omitted in 0..params.len() {
        let changed = params
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != omitted)
            .map(|(_, v)| v.as_str())
            .collect::<Vec<_>>()
            .join("&");
        let (status, body) = w
            .call(
                Method::GET,
                &format!("{PATH}&{changed}&cursor={cursor}"),
                w.ops,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["error"]["code"], "cursor_invalid");
    }
    let mut ids = Vec::new();
    loop {
        assert_eq!(page["totals"]["events"], 8);
        assert_eq!(page["filter_options"], first_options);
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
        page = get(&w, &format!("{suffix}&cursor={cursor}")).await;
    }
    assert_eq!(ids.len(), 8);
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 8);
    assert_eq!(
        get(&w, &format!("{suffix}&flagged=true")).await["totals"]["events"],
        8
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_filters_refuse_without_a_read_record(pool: PgPool) {
    let w = world(pool.clone()).await;
    let other = world(pool).await;
    seed(&w).await;
    for query in [
        "actor=bad".into(),
        format!("actor={}", other.hr),
        "action=missing.action".into(),
        "target_type=missing".into(),
        "from=2026-09-31".into(),
        "from=2026-09-1".into(),
        "from=2026-08-31".into(),
        "to=2026-10-01".into(),
        "from=2026-09-11&to=2026-09-10".into(),
        "from=".into(),
        "to=%00".into(),
        "action=%00".into(),
        "target_type=%0A".into(),
    ] {
        let (status, body) = w
            .call(Method::GET, &format!("{PATH}&{query}"), w.ops, None)
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{query}: {body}");
        assert_eq!(body["error"]["code"], "filter_invalid", "{query}: {body}");
    }
    let (status, body) = w
        .call(
            Method::GET,
            "/api/v1/access/access-log?period=0000-09&from=0000-09-01",
            w.ops,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "filter_invalid");
    let reads: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log.review_read'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(reads, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn filters_keep_live_cedar_scope_refusals_and_atomic_read_audit(pool: PgPool) {
    let mut w = world(pool).await;
    seed(&w).await;
    let path = format!("{PATH}&actor={}&action=employee.export", w.hr);
    let (status, body) = w.call(Method::GET, &path, w.hr, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "access_denied");
    assert!(body.get("filter_options").is_none());
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
    let (status, body) = w.call(Method::GET, &path, w.hr, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "scope_tenant_wide_only");
    assert!(body.get("filter_options").is_none());
    w.grant(json!([grant_op(w.hr, role, "TENANT", None, true)]))
        .await;
    let (status, body) = w.call(Method::GET, &path, w.hr, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["filter_options"]["actors"].is_array());
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE org_id=$1",
    )
    .bind(w.org)
    .bind(w.ops.as_uuid())
    .execute(&w.owner)
    .await
    .unwrap();
    assert_eq!(
        w.call(Method::GET, &path, w.hr, None).await.0,
        StatusCode::FORBIDDEN
    );
    sqlx::raw_sql("CREATE FUNCTION refuse_filtered_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='access_log.review_read' THEN RAISE EXCEPTION 'read audit refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_filtered_read BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_filtered_read()")
        .execute(&w.owner).await.unwrap();
    let (status, body) = w.call(Method::GET, &path, w.ops, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.get("filter_options").is_none());
    assert!(body.get("items").is_none());
}
