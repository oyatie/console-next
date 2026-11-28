// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Live Postgres HTTP verification for atomic combined invite + initial
//! role/scope grants (`POST /api/v1/access/invites`) under `console_rt` (`FORCE RLS`).

mod support;

use std::net::SocketAddr;

use axum::body::{Body, to_bytes};
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use console_kernel_core::UserId;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{World, grant_op, world};
use tower::ServiceExt;
use uuid::Uuid;

async fn call_idem(
    w: &World,
    method: Method,
    uri: &str,
    user: UserId,
    idem: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let token = w.token(user).await;
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(k) = idem {
        b = b.header("idempotency-key", k);
    }
    let mut req = b
        .body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
        .unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([203, 0, 113, 9], 40000))));
    let res = w.router().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn combined_invite_commits_atomically_and_leaves_zero_partial_state_on_grant_refusal(
    pool: PgPool,
) {
    let mut w = world(pool).await;
    let active_role = w
        .role(
            "Workplace HR",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    let access_role = w
        .role(
            "Access Admin",
            json!([{ "domain": "access", "levels": ["edit"] }]),
        )
        .await;
    let manager_grant = w
        .grant(json!([grant_op(w.hr, access_role, "TENANT", None, true)]))
        .await;

    let baseline_users: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE org_id = $1")
        .bind(w.org)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    let baseline_grants: i64 =
        sqlx::query_scalar("SELECT count(*) FROM access_grants WHERE org_id = $1")
            .bind(w.org)
            .fetch_one(&w.owner)
            .await
            .unwrap();

    let hr_step = w.hr_key.step_up(&w.owner).await;
    let (st, fail_a) = call_idem(
        &w,
        Method::POST,
        "/api/v1/access/invites",
        w.hr,
        Some("idem-fail-ceiling-0001"),
        Some(json!({
            "display_name": "Park Fail A",
            "sign_in_id": "fail_a",
            "reason_code": "PROMOTION_OR_REASSIGNMENT",
            "grants": [{
                "role_id": active_role,
                "scope": { "kind": "WORKPLACE", "node_id": w.wp_a, "include_descendants": true },
                "effective_in_setup": true
            }],
            "step_up": hr_step
        })),
    )
    .await;
    assert_eq!(
        (st, fail_a["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("invite_grants_refused")),
        "{fail_a}"
    );

    let ops_step = w.ops_key.step_up(&w.owner).await;
    let (st, fail_b) = call_idem(
        &w,
        Method::POST,
        "/api/v1/access/invites",
        w.ops,
        Some("idem-fail-partial-0002"),
        Some(json!({
            "display_name": "Park Fail B",
            "sign_in_id": "fail_b",
            "reason_code": "PROMOTION_OR_REASSIGNMENT",
            "grants": [
                {
                    "role_id": active_role,
                    "scope": { "kind": "WORKPLACE", "node_id": w.wp_a, "include_descendants": true },
                    "effective_in_setup": true
                },
                {
                    "role_id": active_role,
                    "scope": { "kind": "LEGAL_ENTITY", "node_id": Uuid::new_v4(), "include_descendants": true },
                    "effective_in_setup": true
                }
            ],
            "step_up": ops_step
        })),
    )
    .await;
    assert_eq!(
        (st, fail_b["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("invite_grants_refused")),
        "{fail_b}"
    );

    let (after_users, after_logins, after_grants, after_otps, after_audits): (i64, i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT (SELECT count(*) FROM users WHERE org_id = $1),
                    (SELECT count(*) FROM user_sign_in_ids WHERE org_id = $1 AND login IN ('fail_a', 'fail_b')),
                    (SELECT count(*) FROM access_grants WHERE org_id = $1),
                    (SELECT count(*) FROM auth_bootstrap_credentials WHERE org_id = $1),
                    (SELECT count(*) FROM audit_events WHERE org_id = $1 AND action IN ('users.create', 'access.invites.grant', 'auth.bootstrap_otp.issue'))",
        )
        .bind(w.org)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(
        (
            after_users,
            after_logins,
            after_grants,
            after_otps,
            after_audits
        ),
        (baseline_users, 0, baseline_grants, 0, 0),
        "failed combined invite must leave zero partial users, logins, grants, OTPs, or audit rows"
    );

    let (st, prev) = w
        .call(
            Method::POST,
            "/api/v1/access/invites/preview",
            w.ops,
            Some(json!({
                "display_name": "Choi Valid",
                "sign_in_id": "choi_ok",
                "reason_code": "PROMOTION_OR_REASSIGNMENT",
                "grants": [{
                    "role_id": active_role,
                    "scope": { "kind": "WORKPLACE", "node_id": w.wp_a, "include_descendants": true },
                    "effective_in_setup": true
                }]
            })),
        )
        .await;
    assert_eq!(
        (st, prev["refused"].clone()),
        (StatusCode::OK, json!(0)),
        "{prev}"
    );

    let ops_step = w.ops_key.step_up(&w.owner).await;
    let body = json!({
        "display_name": "Choi Valid",
        "sign_in_id": "choi_ok",
        "reason_code": "PROMOTION_OR_REASSIGNMENT",
        "grants": [{
            "role_id": active_role,
            "scope": { "kind": "WORKPLACE", "node_id": w.wp_a, "include_descendants": true },
            "effective_in_setup": true
        }],
        "step_up": ops_step
    });
    let (st, created) = call_idem(
        &w,
        Method::POST,
        "/api/v1/access/invites",
        w.ops,
        Some("idem-ok-invite-0003"),
        Some(body.clone()),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{created}");
    let otp = created["otp"].as_str().unwrap();
    assert!(!otp.is_empty());
    assert_eq!(created["grants"].as_array().unwrap().len(), 1);
    assert_eq!(created["grants"][0]["enforcement"], "ENFORCED");

    let mut replay = body;
    replay["step_up"] = w.ops_key.step_up(&w.owner).await;
    let (status, receipt) = call_idem(
        &w,
        Method::POST,
        "/api/v1/access/invites",
        w.ops,
        Some("idem-ok-invite-0003"),
        Some(replay.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["operation_id"], created["operation_id"]);
    assert!(receipt["otp"].is_null());

    replay["step_up"] = w.hr_key.step_up(&w.owner).await;
    let (other, _) = call_idem(
        &w,
        Method::POST,
        "/api/v1/access/invites",
        w.hr,
        Some("idem-ok-invite-0003"),
        Some(replay),
    )
    .await;
    assert_eq!(
        other,
        StatusCode::FORBIDDEN,
        "a different account manager cannot read the receipt"
    );

    let central: Option<String> = sqlx::query_scalar(
        "SELECT result::text FROM command_outcomes WHERE org_id=$1 AND actor_id=$2 AND idempotency_key='idem-ok-invite-0003'",
    )
    .bind(w.org).bind(w.ops.as_uuid()).fetch_one(&w.owner).await.unwrap();
    assert!(
        central.is_none(),
        "invites may be recovered only through a new step-up"
    );

    let stored: String = sqlx::query_scalar(
        "SELECT response::text FROM api_idempotency_keys WHERE org_id = $1 AND operation = 'access.invites.create'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert!(!stored.contains(otp), "idempotency receipt must redact otp");

    let new_uid: Uuid = created["user"]["id"].as_str().unwrap().parse().unwrap();
    let bootstrap_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_bootstrap_credentials WHERE org_id = $1 AND user_id = $2 AND redeemed_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL",
    )
    .bind(w.org)
    .bind(new_uid)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(
        bootstrap_rows, 1,
        "exactly one unredeemed bootstrap OTP must exist"
    );
    let own_key = "idem-manager-receipt";
    let mut own =
        json!({"display_name":"Former Manager Invite", "sign_in_id":"manager_invite", "grants":[]});
    own["step_up"] = w.hr_key.step_up(&w.owner).await;
    let (fresh, _) = call_idem(
        &w,
        Method::POST,
        "/api/v1/access/invites",
        w.hr,
        Some(own_key),
        Some(own.clone()),
    )
    .await;
    assert_eq!(fresh, StatusCode::CREATED);
    w.grant(json!([{ "op":"revoke", "grant_id":manager_grant[0]["id"] }]))
        .await;
    own["step_up"] = w.hr_key.step_up(&w.owner).await;
    let (revoked, _) = call_idem(
        &w,
        Method::POST,
        "/api/v1/access/invites",
        w.hr,
        Some(own_key),
        Some(own),
    )
    .await;
    assert_eq!(revoked, StatusCode::FORBIDDEN);
}

#[path = "invites_api/receipt_upgrade.rs"]
mod receipt_upgrade;
