#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R3 SCOPE: 「권한 요청」 is a record (governance-22, people-self-38), who
//! can grant is a read (worst-case-44), each scoped grant line names what it
//! does not reach (governance-18), a closed 법인/사업장 is never a new scope
//! (company-21), and a deactivated account's grants read as using nothing
//! (people-self-46). Every refusal: status, code, nothing written.

mod support;

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{World, grant_op, world};

async fn rows(w: &World, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) FROM {table} WHERE org_id = $1"
    )))
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap()
}

/// The request's own audit rows (a refused call may log its denial elsewhere).
async fn request_audits(w: &World) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action LIKE 'access.request.%'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap()
}

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

const REQUESTS: &str = "/api/v1/access/requests";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_refused_screen_files_one_request_that_a_granter_closes(pool: PgPool) {
    let w = world(pool).await;
    let ask = json!({ "screen": "/people", "reason_code": "NEW_DUTY" });
    let (status, first) = w
        .call(Method::POST, REQUESTS, w.hr, Some(ask.clone()))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{first}");
    let (status, again) = w.call(Method::POST, REQUESTS, w.hr, Some(ask)).await;
    assert_eq!(
        (status, &again["id"]),
        (StatusCode::OK, &first["id"]),
        "one open per screen"
    );

    // Refusals: nothing written.
    let (requests, audits) = (rows(&w, "access_requests").await, request_audits(&w).await);
    let other = json!({ "screen": "/org", "reason_code": "OTHER" });
    let (status, body) = w.call(Method::POST, REQUESTS, w.hr, Some(other)).await;
    assert_eq!(
        (status, code(&body)),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "access_request_note_required"
        )
    );
    let id = first["id"].as_str().unwrap();
    let close = |s: &str| json!({ "status": s });
    let path = format!("{REQUESTS}/{id}/close");
    let (status, body) = w
        .call(Method::POST, &path, w.hr2, Some(close("DONE")))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::FORBIDDEN, "access_denied"),
        "not a granter"
    );
    let (status, body) = w
        .call(Method::POST, &path, w.hr2, Some(close("WITHDRAWN")))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::FORBIDDEN, "access_denied"),
        "not the requester"
    );
    let missing = format!("{REQUESTS}/{}/close", uuid::Uuid::new_v4());
    let (status, body) = w
        .call(Method::POST, &missing, w.ops, Some(close("DONE")))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::NOT_FOUND, "access_request_not_found")
    );
    assert_eq!(rows(&w, "access_requests").await, requests);
    assert_eq!(
        request_audits(&w).await,
        audits,
        "a refusal writes no audit row"
    );

    // The granter sees the open request and closes it, once.
    let (_, open) = w.call(Method::GET, REQUESTS, w.ops, None).await;
    assert!(
        open.as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == first["id"]),
        "{open}"
    );
    let (_, mine) = w.call(Method::GET, REQUESTS, w.hr2, None).await;
    assert_eq!(mine, json!([]), "a non-granter sees only their own");
    let (status, done) = w
        .call(Method::POST, &path, w.ops, Some(close("DONE")))
        .await;
    assert_eq!(
        (status, &done["status"]),
        (StatusCode::OK, &json!("DONE")),
        "{done}"
    );
    let (status, body) = w
        .call(Method::POST, &path, w.ops, Some(close("DECLINED")))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "access_request_closed")
    );
    let (status, body) = w
        .call(Method::POST, &path, w.hr, Some(close("WITHDRAWN")))
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::CONFLICT, "access_request_closed")
    );
    let logged = request_audits(&w).await;
    assert_eq!(logged, 2, "create + close");

    // Who can grant: the ops account (and holders of 권한 관리 등록·수정).
    let (status, granters) = w
        .call(Method::GET, "/api/v1/access/granters", w.hr, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(granters, json!({ "count": 1, "names": ["운영 계정"] }));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_scoped_line_names_its_caveats_and_a_closed_scope_is_refused(pool: PgPool) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "인사 실무",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    w.grant(json!([grant_op(
        w.hr,
        role,
        "LEGAL_ENTITY",
        Some(w.le_a),
        true
    )]))
    .await;
    let (_, me) = w.call(Method::GET, "/api/v1/access/me", w.hr, None).await;
    let edit = me["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["level"] == "edit")
        .unwrap();
    assert_eq!(
        edit["caveats"],
        json!(["scope_register", "tenant_wide_hr_basic"]),
        "{me}"
    );

    // company-21 (regression): a closed 사업장 is not a scope.
    sqlx::query("UPDATE workplaces SET closed_on = current_date - 1 WHERE id = $1")
        .bind(w.wp_b)
        .execute(&w.owner)
        .await
        .unwrap();
    let before = rows(&w, "access_grants").await;
    let body = json!({ "reason_code": "PROMOTION_OR_REASSIGNMENT",
                       "operations": [grant_op(w.hr2, role, "WORKPLACE", Some(w.wp_b), true)] });
    let (status, p) = w
        .call(
            Method::POST,
            "/api/v1/access/grants/preview",
            w.ops,
            Some(body),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{p}");
    assert_eq!(p["items"][0]["refusal"]["code"], "scope_node_closed", "{p}");
    assert_eq!(rows(&w, "access_grants").await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_deactivated_holder_reads_as_using_nothing_and_the_list_says_who_has_a_passkey(
    pool: PgPool,
) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "인사 실무",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    w.grant(json!([
        grant_op(w.hr, role, "TENANT", None, true),
        grant_op(w.hr2, role, "TENANT", None, true),
    ]))
    .await;
    let (_, list) = w
        .call(Method::GET, "/api/v1/access/grants", w.ops, None)
        .await;
    let of = |list: &Value, who: uuid::Uuid| {
        list.as_array()
            .unwrap()
            .iter()
            .find(|g| g["account_id"] == json!(who))
            .cloned()
            .unwrap()
    };
    assert_eq!(
        of(&list, *w.hr.as_uuid())["account_has_passkey"],
        true,
        "{list}"
    );
    assert_eq!(of(&list, *w.hr2.as_uuid())["account_has_passkey"], false);
    assert_eq!(of(&list, *w.hr2.as_uuid())["account_active"], true);

    sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(w.hr2.as_uuid())
        .execute(&w.owner)
        .await
        .unwrap();
    let (_, list) = w
        .call(Method::GET, "/api/v1/access/grants", w.ops, None)
        .await;
    assert_eq!(of(&list, *w.hr2.as_uuid())["account_active"], false);
    let uri = format!("/api/v1/access/accounts/{}/effective", w.hr2.as_uuid());
    let (status, theirs) = w.call(Method::GET, &uri, w.ops, None).await;
    assert_eq!(status, StatusCode::OK, "{theirs}");
    let states: Vec<&Value> = theirs["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| &e["enforcement"])
        .collect();
    assert!(
        !states.is_empty() && states.iter().all(|s| *s == "ACCOUNT_INACTIVE"),
        "{theirs}"
    );
}
