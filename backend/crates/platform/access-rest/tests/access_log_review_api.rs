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
use uuid::Uuid;

async fn call_idem(
    w: &World,
    method: Method,
    uri: &str,
    user: UserId,
    idem_key: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
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
        .insert(ConnectInfo(SocketAddr::from(([203, 0, 113, 7], 40000))));
    let resp = w.router().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn access_log_review_http_lifecycle_enforces_authz_step_up_and_tenant_isolation(
    pool: PgPool,
) {
    let mut w = world(pool.clone()).await;
    let other = world(pool).await;
    let period = "2026-09";
    let base = format!("/api/v1/access/access-log/reviews/{period}");

    let event_id: Uuid = sqlx::query_scalar(
        "INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,created_at,after_snap,outcome,ip) \
         VALUES($1,$2,'employee.rrn_reveal','employee','test',repeat('a',32),repeat('b',16),'2026-09-01T02:00:00Z','2026-09-10T00:00:00Z','{\"self_read\":false,\"subject_count\":1}'::jsonb,'ALLOWED','203.0.113.9') \
         RETURNING id",
    )
    .bind(w.org)
    .bind(w.hr.as_uuid())
    .fetch_one(&w.owner)
    .await
    .unwrap();

    // Unprivileged user gets 403; branch-scoped grant gets 403 scope_tenant_wide_only.
    let (st, _) = call_idem(&w, Method::GET, &base, w.hr, None, None).await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let scoped_role = w
        .role(
            "Audit View",
            json!([{"domain":"audit","levels":["approve"]}]),
        )
        .await;
    w.grant(json!([grant_op(
        w.hr2,
        scoped_role,
        "LEGAL_ENTITY",
        Some(w.le_a),
        true
    )]))
    .await;
    let (st, scoped) = call_idem(&w, Method::GET, &base, w.hr2, None, None).await;
    assert_eq!(
        (st, scoped["error"]["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("scope_tenant_wide_only"))
    );

    // Before start, projection is overdue (for closed past month) and started_at is null.
    let (st, initial) = call_idem(&w, Method::GET, &base, w.ops, None, None).await;
    assert_eq!(st, StatusCode::OK, "{initial}");
    assert!(initial["started_at"].is_null());

    // Start review with idempotent replay.
    let start_key = "review-start-http-key-001";
    let (st, started) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/start"),
        w.ops,
        Some(start_key),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{started}");
    assert_eq!(started["flags_seen"]["flagged_total"], 1);
    let (st, replayed) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/start"),
        w.ops,
        Some(start_key),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{replayed}");
    assert_eq!(replayed, started);

    // Other tenant still sees not started / zero items from tenant A.
    let (st, other_rev) = call_idem(&other, Method::GET, &base, other.ops, None, None).await;
    assert_eq!(st, StatusCode::OK, "{other_rev}");
    assert!(other_rev["started_at"].is_null());

    // Cannot complete with open target.
    let (st, incomplete) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/complete"),
        w.ops,
        Some("review-complete-open-001"),
        Some(json!({})),
    )
    .await;
    assert_eq!(
        (st, incomplete["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("review_incomplete"))
    );

    // Unknown target returns 404; invalid disposition returns 422.
    let (st, missing) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/findings"),
        w.ops,
        Some("review-finding-missing-001"),
        Some(
            json!({"event_id": Uuid::new_v4(), "disposition": "confirmed", "outcome": "justified"}),
        ),
    )
    .await;
    assert_eq!(
        (st, missing["error"]["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("finding_target_not_found")),
        "{missing}"
    );

    let (st, invalid) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/findings"),
        w.ops,
        Some("review-finding-invalid-001"),
        Some(json!({"event_id": event_id, "disposition": "bad"})),
    )
    .await;
    assert_eq!(
        (st, invalid["error"]["code"].as_str()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Some("disposition_invalid")
        )
    );

    // Record action_required finding (with follow-up), then supersede with confirmed finding.
    let (st, action_req) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/findings"),
        w.ops,
        Some("review-finding-action-001"),
        Some(json!({
            "event_id": event_id,
            "disposition": "action_required",
            "note": "Check ticket",
            "follow_up": {"kind": "incident", "ref": "INC-42", "closed": false}
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{action_req}");
    assert_eq!(action_req["follow_up"], json!({"open": 1, "total": 1}));

    let (st, confirmed) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/findings"),
        w.ops,
        Some("review-finding-confirm-001"),
        Some(json!({
            "event_id": event_id,
            "disposition": "confirmed",
            "outcome": "justified",
            "note": "Verified authorization",
            "follow_up": {"kind": "none"}
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{confirmed}");
    assert_eq!(confirmed["follow_up"], json!({"open": 0, "total": 0}));

    // Complete requires passkey step-up (428 without, 200 with).
    let (st, need_step_up) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/complete"),
        w.ops,
        Some("review-complete-nostep-001"),
        Some(json!({})),
    )
    .await;
    assert_eq!(
        (st, need_step_up["error"]["code"].as_str()),
        (StatusCode::PRECONDITION_REQUIRED, Some("step_up_required"))
    );

    let step_up = w.ops_key.step_up(&w.owner).await;
    let (st, done) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/complete"),
        w.ops,
        Some("review-complete-ok-001"),
        Some(json!({"step_up": step_up})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{done}");
    assert_eq!(done["state"], "complete");

    // Findings after complete are rejected (409).
    let (st, after_done) = call_idem(
        &w,
        Method::POST,
        &format!("{base}/findings"),
        w.ops,
        Some("review-finding-after-001"),
        Some(json!({"event_id": event_id, "disposition": "confirmed", "outcome": "justified"})),
    )
    .await;
    assert_eq!(
        (st, after_done["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("review_already_complete"))
    );
}
