#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Transport and domain key refusals retain audited, terminal receipts.
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;
#[path = "support/refusals.rs"]
#[expect(
    dead_code,
    reason = "The key suite shares snapshots but uses raw requests."
)]
mod refusals;
#[path = "support/http.rs"]
mod support;
use refusals::{audit_rows, business_state, code, field_codes};
use support::{count, ctx, entity_body, tenant};
const ADMIN: &[&str] = &["SUPER_ADMIN"];

/// A missing key retains the handler's field refusal with a generated receipt;
/// an invalid transport key is denied before any registry or business write.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_write_without_a_usable_idempotency_key_is_refused(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let before = audit_rows(&pool, org).await;
    let business = business_state(&pool, org).await;
    let commands = count(&pool, "command_outcomes", org).await;
    let body = Some(entity_body().to_string().into_bytes());
    let (status, missing) = ctx
        .raw(
            "POST",
            "/api/v1/legal-entities",
            "application/json",
            body.clone(),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{missing}");
    assert!(
        field_codes(&missing).contains(&("Idempotency-Key".into(), "required".into())),
        "{missing}"
    );
    assert_eq!(code(&missing), "validation_failed");
    let id = Uuid::parse_str(missing["error"]["operation_id"].as_str().unwrap()).unwrap();
    let receipt: (String, String, String, Option<Value>, Value) = sqlx::query_as(
        "SELECT idempotency_key,state,refusal_code,result,touched FROM command_outcomes \
         WHERE org_id=$1 AND actor_id=$2 AND id=$3",
    )
    .bind(org)
    .bind(ctx.user.as_uuid())
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        Uuid::parse_str(&receipt.0).is_ok(),
        "server-generated retry key"
    );
    assert_eq!(receipt.1, "REFUSED");
    assert_eq!(receipt.2, "validation_failed");
    assert_eq!(receipt.3, None);
    assert_eq!(receipt.4, json!([]));
    assert_eq!(count(&pool, "command_outcomes", org).await, commands + 1);
    assert_eq!(audit_rows(&pool, org).await, before + 2);
    let req = http::Request::builder()
        .method("POST")
        .uri("/api/v1/legal-entities")
        .header(http::header::AUTHORIZATION, format!("Bearer {}", ctx.token))
        .header(http::header::CONTENT_TYPE, "application/json")
        .header("Idempotency-Key", "not-a-uuid")
        .body(axum::body::Body::from(entity_body().to_string()))
        .unwrap();
    let response = tower::ServiceExt::oneshot(ctx.service.clone(), req)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let invalid: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(code(&invalid), "invalid_request_key", "{invalid}");
    assert!(invalid["error"]["operation_id"].is_null());
    assert_eq!(count(&pool, "command_outcomes", org).await, commands + 1);
    assert_eq!(count(&pool, "legal_entities", org).await, 0);
    assert_eq!(business_state(&pool, org).await, business);
    let evidence: Vec<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_array(action,outcome,command_id,after_snap->>'refusal_code') \
         FROM audit_events WHERE org_id=$1 AND action LIKE 'command.%' ORDER BY created_at,id",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        evidence,
        vec![
            json!(["command.received", "ALLOWED", id, null]),
            json!(["command.refused", "DENIED", id, "validation_failed"]),
            json!(["command.refused", "DENIED", null, "invalid_request_key"])
        ],
        "only registration and denied audit evidence, no successful mutation"
    );
    assert_eq!(audit_rows(&pool, org).await, before + 3);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn non_uuid_domain_key_is_refused_without_a_business_write(pool: PgPool) {
    let (org, user) = tenant(&pool, ADMIN).await;
    let ctx = ctx(&pool, org, user, ADMIN, None).await;
    let business = business_state(&pool, org).await;
    let before = audit_rows(&pool, org).await;
    let request = http::Request::builder()
        .method("POST")
        .uri("/api/v1/legal-entities")
        .header(http::header::AUTHORIZATION, format!("Bearer {}", ctx.token))
        .header(http::header::CONTENT_TYPE, "application/json")
        .header("Idempotency-Key", "valid-transport-non-uuid")
        .body(axum::body::Body::from(entity_body().to_string()))
        .unwrap();
    let response = tower::ServiceExt::oneshot(ctx.service.clone(), request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let refused: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(code(&refused), "validation_failed");
    assert!(field_codes(&refused).contains(&("Idempotency-Key".into(), "invalid_uuid".into())));
    assert_eq!(business_state(&pool, org).await, business);
    let id: Uuid = refused["error"]["operation_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let evidence:(String,Option<Value>,Value,i64)=sqlx::query_as(
        "SELECT state,result,touched,(SELECT count(*) FROM audit_events e WHERE e.org_id=c.org_id AND e.command_id=c.id AND e.action='command.refused' AND e.outcome='DENIED' AND e.after_snap->>'refusal_code'='validation_failed') FROM command_outcomes c WHERE org_id=$1 AND id=$2")
        .bind(org).bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(evidence, ("REFUSED".into(), None, json!([]), 1));
    assert_eq!(audit_rows(&pool, org).await, before + 2);
}
