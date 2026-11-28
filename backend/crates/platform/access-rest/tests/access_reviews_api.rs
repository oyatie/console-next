// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;

use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use console_kernel_core::UserId;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::net::SocketAddr;
use support::{World, grant_op, world};
use tower::ServiceExt;

async fn call_raw(
    w: &World,
    method: Method,
    uri: &str,
    user: UserId,
    idem_key: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Vec<u8>) {
    let token = w.token(user).await;
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(key) = idem_key {
        builder = builder.header("idempotency-key", key);
    }
    let mut req = builder
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([203, 0, 113, 8], 40001))));
    let resp = w.router().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    (status, bytes)
}

async fn call_json(
    w: &World,
    method: Method,
    uri: &str,
    user: UserId,
    idem_key: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let (st, bytes) = call_raw(w, method, uri, user, idem_key, body).await;
    (st, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn periodic_access_reviews_freeze_grants_enforce_self_review_and_revoke_on_sign_off(
    pool: PgPool,
) {
    let mut w = world(pool).await;
    let role_view = w
        .role(
            "People Reader",
            json!([{"domain": "hr_basic", "levels": ["view"]}]),
        )
        .await;
    let role_reviewer = w
        .role(
            "Access Reviewer",
            json!([{"domain": "access", "levels": ["view", "edit"]}]),
        )
        .await;

    w.grant(json!([
        grant_op(w.hr, role_view, "TENANT", None, true),
        grant_op(w.hr2, role_reviewer, "TENANT", None, true),
    ]))
    .await;

    let period = "2026-Q4";
    let base = format!("/api/v1/access/reviews/{period}");

    // 1. Unprivileged hr cannot list reviews (403); reviewer hr2 and ops can.
    let (st, _) = call_json(&w, Method::GET, "/api/v1/access/reviews", w.hr, None, None).await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, cycles) =
        call_json(&w, Method::GET, "/api/v1/access/reviews", w.hr2, None, None).await;
    assert_eq!(st, StatusCode::OK, "{cycles}");
    assert!(cycles.as_array().unwrap().len() >= 2);

    // 2. Start freezes the two active grants.
    let (st, started) = call_json(
        &w,
        Method::POST,
        &format!("{base}/start"),
        w.ops,
        Some("access-review-start-0001"),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{started}");
    assert_eq!(started["summary"]["state"], "OPEN");
    assert_eq!(started["summary"]["frozen_count"], 2);
    let items = started["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);

    let hr_item = items
        .iter()
        .find(|i| i["account_id"] == json!(w.hr.as_uuid()))
        .unwrap();
    let hr2_item = items
        .iter()
        .find(|i| i["account_id"] == json!(w.hr2.as_uuid()))
        .unwrap();

    // 3. Self-review is refused: hr2 cannot decide their own role grant!
    let (st, self_err) = call_json(
        &w,
        Method::POST,
        &format!("{base}/decisions"),
        w.hr2,
        Some("access-review-self-0001"),
        Some(json!({
            "item_id": hr2_item["id"],
            "decision": "KEEP"
        })),
    )
    .await;
    assert_eq!(
        (st, self_err["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("self_review_forbidden"))
    );

    // 4. hr2 decides REVOKE on hr's grant (requiring reason_code); ops decides KEEP on hr2's grant.
    let (st, after_first) = call_json(
        &w,
        Method::POST,
        &format!("{base}/decisions"),
        w.hr2,
        Some("access-review-decide-hr-0001"),
        Some(json!({
            "item_id": hr_item["id"],
            "decision": "REVOKE",
            "reason_code": "ROLE_REVIEW",
            "reason_note": "No longer assigned to HR operations"
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{after_first}");
    assert_eq!(after_first["summary"]["decided_count"], 1);

    // Completing while 1 of 2 items is undecided fails with 409 review_incomplete.
    let step_up_early = w.ops_key.step_up(&w.owner).await;
    let (st, inc_err) = call_json(
        &w,
        Method::POST,
        &format!("{base}/complete"),
        w.ops,
        Some("access-review-complete-early-0001"),
        Some(json!({ "step_up": step_up_early })),
    )
    .await;
    assert_eq!(
        (st, inc_err["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("review_incomplete"))
    );

    let (st, _) = call_json(
        &w,
        Method::POST,
        &format!("{base}/decisions"),
        w.ops,
        Some("access-review-decide-hr2-0001"),
        Some(json!({
            "item_id": hr2_item["id"],
            "decision": "KEEP"
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // 5. Completing without passkey returns 428; completing with passkey revokes hr's grant!
    let (st, no_step) = call_json(
        &w,
        Method::POST,
        &format!("{base}/complete"),
        w.ops,
        Some("access-review-complete-nostep-0001"),
        Some(json!({})),
    )
    .await;
    assert_eq!(st, StatusCode::PRECONDITION_REQUIRED, "{no_step}");

    let step_up = w.ops_key.step_up(&w.owner).await;
    let (st, done) = call_json(
        &w,
        Method::POST,
        &format!("{base}/complete"),
        w.ops,
        Some("access-review-complete-ok-0001"),
        Some(json!({ "step_up": step_up })),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{done}");
    assert_eq!(done["summary"]["state"], "COMPLETE");

    let hr_grant_status: String = sqlx::query_scalar(
        "SELECT status FROM access_grants WHERE org_id = $1 AND account_id = $2",
    )
    .bind(w.org)
    .bind(w.hr.as_uuid())
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(hr_grant_status, "REVOKED");

    // 6. CSV export returns UTF-8 CSV and logs access_review.export.
    let (st, csv_bytes) = call_raw(
        &w,
        Method::GET,
        &format!("{base}/export.csv?export_purpose=QUARTERLY_AUDIT"),
        w.ops,
        None,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let csv_text = String::from_utf8(csv_bytes).unwrap();
    assert!(csv_text.contains("REVOKE"));
    assert!(csv_text.contains("KEEP"));
}

#[path = "access_reviews_api/scope_evidence.rs"]
mod scope_evidence;
