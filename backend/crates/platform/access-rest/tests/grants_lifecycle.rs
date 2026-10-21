#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Grants over HTTP, continued: the grantor ceiling (GR-7) and a grant's
//! re-dating, revocation and ledger history.

mod support;

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{World, grant_op, world};

async fn preview(w: &World, actor: console_kernel_core::UserId, ops: Value) -> Value {
    let body = json!({ "reason_code": "PROMOTION_OR_REASSIGNMENT", "operations": ops });
    let (status, out) = w
        .call(
            Method::POST,
            "/api/v1/access/grants/preview",
            actor,
            Some(body),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    out
}

fn refusal(preview: &Value, i: usize) -> Value {
    preview["items"][i]["refusal"]["code"].clone()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_grantor_gives_only_what_they_hold_where_they_manage_access(pool: PgPool) {
    let mut w = world(pool).await;
    let admin = w.role("권한 담당", json!([
        { "domain": "access", "levels": ["edit"] }, { "domain": "hr_basic", "levels": ["view"] },
    ])).await;
    let viewer = w
        .role(
            "인사 조회",
            json!([{ "domain": "hr_basic", "levels": ["view"] }]),
        )
        .await;
    let editor = w
        .role(
            "인사 수정",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    w.grant(json!([grant_op(
        w.hr,
        admin,
        "LEGAL_ENTITY",
        Some(w.le_a),
        true
    )]))
    .await;

    let p = preview(
        &w,
        w.hr,
        json!([
            grant_op(w.hr2, editor, "LEGAL_ENTITY", Some(w.le_a), true),
            grant_op(w.hr2, viewer, "LEGAL_ENTITY", Some(w.le_b), true),
            grant_op(w.hr, viewer, "WORKPLACE", Some(w.wp_a), true),
        ]),
    )
    .await;
    assert_eq!(refusal(&p, 0), "grant_exceeds_grantor");
    assert_eq!(
        refusal(&p, 1),
        "access_denied",
        "법인 B is outside the grantor's 권한 관리"
    );
    assert_eq!(refusal(&p, 2), "self_grant_forbidden");
    let (status, ok) = w
        .grant_as(
            w.hr,
            json!([grant_op(w.hr2, viewer, "WORKPLACE", Some(w.wp_a), true)]),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{ok}");
    assert_eq!(ok[0]["granted_by"], json!(w.hr.as_uuid()));
    // No dead end for a scoped 권한 관리 holder: it reads the role list it
    // grants from, and the grants over the nodes it manages — not 법인 B's.
    w.grant(json!([grant_op(
        w.hr2,
        viewer,
        "LEGAL_ENTITY",
        Some(w.le_b),
        true
    )]))
    .await;
    let (status, roles) = w
        .call(Method::GET, "/api/v1/access/roles", w.hr, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{roles}");
    assert_eq!(roles.as_array().unwrap().len(), 3);
    let (status, grants) = w
        .call(Method::GET, "/api/v1/access/grants", w.hr, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{grants}");
    let mut nodes: Vec<String> = grants
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["scope"]["node_id"].as_str().unwrap().to_owned())
        .collect();
    nodes.sort();
    let mut expect = vec![w.le_a.to_string(), w.wp_a.to_string()];
    expect.sort();
    assert_eq!(
        nodes, expect,
        "법인 B's grant stays out of a 법인 A holder's list"
    );
    let (_, all) = w
        .call(Method::GET, "/api/v1/access/grants", w.ops, None)
        .await;
    assert_eq!(all.as_array().unwrap().len(), 3);
    let (status, _) = w
        .call(
            Method::POST,
            "/api/v1/access/roles",
            w.hr,
            Some(json!({ "name_ko": "x", "lines": [{ "domain": "org", "levels": ["view"] }] })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "role definitions need 권한 관리 over the whole tenant"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_grant_is_re_dated_and_revoked_and_its_history_kept(pool: PgPool) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "조직 조회",
            json!([{ "domain": "org", "levels": ["view"] }]),
        )
        .await;
    let g = w
        .grant(json!([grant_op(w.hr, role, "TENANT", None, true)]))
        .await;
    let id = g[0]["id"].as_str().unwrap().to_owned();
    let p = preview(
        &w,
        w.ops,
        json!([{ "op": "set_end", "grant_id": id, "valid_to": "2020-01-01T00:00:00Z" }]),
    )
    .await;
    assert_eq!(refusal(&p, 0), "valid_range_invalid");
    let end = w
        .grant(json!([{ "op": "set_end", "grant_id": id, "valid_to": "2099-01-01T00:00:00Z" }]))
        .await;
    assert_eq!(end[0]["valid_to"], "2099-01-01T00:00:00Z");
    let gone = w.grant(json!([{ "op": "revoke", "grant_id": id }])).await;
    assert_eq!(gone[0]["enforcement"], "REVOKED");
    let p = preview(&w, w.ops, json!([{ "op": "revoke", "grant_id": id }])).await;
    assert_eq!(refusal(&p, 0), "grant_ended");
    let (_, live) = w
        .call(Method::GET, "/api/v1/access/grants", w.ops, None)
        .await;
    assert_eq!(live, json!([]));
    let (_, all) = w
        .call(
            Method::GET,
            "/api/v1/access/grants?include_ended=true",
            w.ops,
            None,
        )
        .await;
    assert_eq!(all.as_array().unwrap().len(), 1);
    let events: Vec<String> = sqlx::query_scalar(
        "SELECT event FROM authz_grant_ledger WHERE grant_ref = $1 ORDER BY occurred_at, event",
    )
    .bind(&id)
    .fetch_all(&w.owner)
    .await
    .unwrap();
    assert_eq!(events, ["GRANTED", "REDATED", "REVOKED"]);
}
