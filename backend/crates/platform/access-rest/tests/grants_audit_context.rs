#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Grant receipts keep their real audit target and command identity across replay refusal.
mod support;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use console_kernel_core::UserId;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{World, grant_op, world};
use tower::ServiceExt;
use uuid::Uuid;

const PREVIEW: &str = "/api/v1/access/grants/preview";
const APPLY: &str = "/api/v1/access/grants/apply";
const REASON: &str = "PROMOTION_OR_REASSIGNMENT";

async fn audit_context(
    w: &World,
    receipt: Uuid,
    action: &str,
    actor: UserId,
    kind: &str,
    source: &str,
) -> Uuid {
    let row: (String, String, String, Uuid, Uuid) = sqlx::query_as(
        "SELECT source, reason_code, actor_kind, actor, command_id FROM audit_events \
           WHERE org_id = $1 AND target_type = 'access_grant_receipts' \
             AND target_id = $2 AND action = $3 AND outcome = 'ALLOWED'",
    )
    .bind(w.org)
    .bind(receipt.to_string())
    .bind(action)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(
        (row.0.as_str(), row.1.as_str(), row.2.as_str()),
        (source, REASON, kind)
    );
    assert_eq!(row.3, *actor.as_uuid());
    row.4
}

async fn command(w: &World, id: Uuid) -> Value {
    sqlx::query_scalar("SELECT to_jsonb(c) FROM command_outcomes c WHERE org_id = $1 AND id = $2")
        .bind(w.org)
        .bind(id)
        .fetch_one(&w.owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn api_receipt_audits_link_the_actual_receipt_and_receipt_used_links_the_original_outcome(
    pool: PgPool,
) {
    let mut w = world(pool).await;
    let role = w
        .role(
            "조직 조회",
            json!([{ "domain": "org", "levels": ["view"] }]),
        )
        .await;
    let request = json!({ "reason_code": REASON, "operations": [grant_op(w.hr, role, "TENANT", None, true)] });
    let (status, preview) = w.call(Method::POST, PREVIEW, w.ops, Some(request)).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["refused"], 0);
    let receipt: Uuid = preview["receipt_id"].as_str().unwrap().parse().unwrap();
    let stored: Uuid = sqlx::query_scalar("SELECT id FROM access_grant_receipts WHERE org_id = $1")
        .bind(w.org)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(
        stored, receipt,
        "the preview audit must name the inserted receipt, not an unrelated UUID"
    );
    let preview_id = audit_context(
        &w,
        receipt,
        "access.grants.preview",
        w.ops,
        "OPS_ACCOUNT",
        "API",
    )
    .await;
    assert_eq!(command(&w, preview_id).await["state"], "APPLIED");

    let step_up = w.ops_key.step_up(&w.owner).await;
    let (status, applied) = w
        .call(
            Method::POST,
            APPLY,
            w.ops,
            Some(json!({ "receipt_id": receipt, "step_up": step_up })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["items"].as_array().unwrap().len(), 1);
    let original: Uuid = applied["operation_id"].as_str().unwrap().parse().unwrap();
    assert_ne!(original, preview_id);
    assert_eq!(
        audit_context(
            &w,
            receipt,
            "access.grants.apply",
            w.ops,
            "OPS_ACCOUNT",
            "API"
        )
        .await,
        original
    );
    let settled = command(&w, original).await;
    assert_eq!(settled["state"], "APPLIED");
    assert_eq!(settled["result"], applied);
    assert!(!settled["settled_at"].is_null());
    assert_eq!(settled["touched"][0]["type"], "access_grant_receipts");
    assert_eq!(settled["touched"][0]["id"], receipt.to_string());
    let used_at: Option<time::OffsetDateTime> = sqlx::query_scalar(
        "SELECT used_at FROM access_grant_receipts WHERE org_id = $1 AND id = $2",
    )
    .bind(w.org)
    .bind(receipt)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert!(used_at.is_some());

    let step_up = w.ops_key.step_up(&w.owner).await;
    let (status, refused) = w
        .call(
            Method::POST,
            APPLY,
            w.ops,
            Some(json!({ "receipt_id": receipt, "step_up": step_up })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("receipt_used"))
    );
    assert_eq!(
        refused["error"]["original_operation_id"],
        original.to_string()
    );
    let refused_id: Uuid = refused["error"]["operation_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_ne!(
        refused_id, original,
        "the original successful request is distinct from this refused attempt"
    );
    let failed = command(&w, refused_id).await;
    assert_eq!(failed["state"], "CONFLICT");
    assert_eq!(failed["refusal_code"], "receipt_used");
    assert_eq!(
        command(&w, original).await,
        settled,
        "a refused replay cannot rewrite the original request"
    );
    let after_used_at: Option<time::OffsetDateTime> = sqlx::query_scalar(
        "SELECT used_at FROM access_grant_receipts WHERE org_id = $1 AND id = $2",
    )
    .bind(w.org)
    .bind(receipt)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(after_used_at, used_at);
    let grants: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM access_grants WHERE org_id = $1 AND account_id = $2",
    )
    .bind(w.org)
    .bind(w.hr.as_uuid())
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(grants, 1);
    let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM authz_grant_ledger WHERE org_id = $1 AND user_id = $2 AND grant_kind = 'ACCESS_GRANT' AND event = 'GRANTED'")
        .bind(w.org).bind(w.hr.as_uuid()).fetch_one(&w.owner).await.unwrap();
    assert_eq!(ledger, 1);
    let denied: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND command_id = $2 AND action = 'command.refused' AND outcome = 'DENIED' AND after_snap->>'refusal_code' = 'receipt_used'")
        .bind(w.org).bind(refused_id).fetch_one(&w.owner).await.unwrap();
    assert_eq!(denied, 1, "the refusal has its own negative audit row");
}

async fn form_call(w: &World, path: &str, body: Value) -> (StatusCode, Value) {
    let token = w.token(w.hr).await;
    let request = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header("sec-fetch-mode", "cors")
        .header("idempotency-key", Uuid::new_v4().to_string())
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = w.router().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn browser_grant_preview_and_apply_keep_form_source_reason_and_tenant_actor_kind(
    pool: PgPool,
) {
    let mut w = world(pool).await;
    let admin = w
        .role(
            "권한 담당",
            json!([
                { "domain": "access", "levels": ["view", "edit"] },
                { "domain": "org", "levels": ["view"] },
            ]),
        )
        .await;
    let viewer = w
        .role(
            "조직 조회",
            json!([{ "domain": "org", "levels": ["view"] }]),
        )
        .await;
    w.grant(json!([grant_op(w.hr, admin, "TENANT", None, true)]))
        .await;
    let (status, preview) = form_call(&w, PREVIEW, json!({ "reason_code": REASON, "operations": [grant_op(w.hr2, viewer, "TENANT", None, true)] })).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["refused"], 0);
    let receipt: Uuid = preview["receipt_id"].as_str().unwrap().parse().unwrap();
    let preview_id = audit_context(
        &w,
        receipt,
        "access.grants.preview",
        w.hr,
        "TENANT_USER",
        "FORM",
    )
    .await;
    assert_eq!(command(&w, preview_id).await["state"], "APPLIED");
    let step_up = w.hr_key.step_up(&w.owner).await;
    let (status, applied) = form_call(
        &w,
        APPLY,
        json!({ "receipt_id": receipt, "step_up": step_up }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["items"][0]["granted_by"], json!(w.hr.as_uuid()));
    let apply_id = audit_context(
        &w,
        receipt,
        "access.grants.apply",
        w.hr,
        "TENANT_USER",
        "FORM",
    )
    .await;
    assert_eq!(applied["operation_id"], apply_id.to_string());
    assert_eq!(command(&w, apply_id).await["state"], "APPLIED");
}
