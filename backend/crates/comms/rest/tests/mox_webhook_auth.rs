// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use console_comms_adapter_postgres::PgMailStore;
use console_comms_rest::{CommsRestState, MAIL_MOX_WEBHOOK_PATH, router};
use console_platform_test_support::runtime_role_pool;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "test-mox-webhook-secret";

fn incoming_payload() -> Value {
    json!({
        "Version": 0,
        "From": [{ "Name": "Sender", "Address": "sender@example.com" }],
        "To": [{ "Address": "unknown@example.invalid" }],
        "Subject": "hi",
        "MessageID": "<mox-auth-test-1@example.invalid>",
        "References": [],
        "Text": "hello",
        "Meta": {
            "MsgID": 1,
            "RcptTo": "unknown@example.invalid",
            "MailboxName": "Inbox"
        }
    })
}

async fn post_webhook(
    service: axum::Router,
    authorization: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(MAIL_MOX_WEBHOOK_PATH)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(auth) = authorization {
        builder = builder.header(header::AUTHORIZATION, auth);
    }
    let response = service
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn blank_mox_webhook_secret_returns_503(pool: PgPool) {
    let rt = runtime_role_pool(&pool).await;
    for blank in ["", "   "] {
        let state = CommsRestState::new(PgMailStore::new(rt.clone()), None, None)
            .with_mox_webhook_secret(Some(blank.to_owned()));
        let (status, _) = post_webhook(router(state), Some("Bearer "), incoming_payload()).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn mox_webhook_rejects_length_delta_and_scheme_mismatches_and_accepts_exact_secret(
    pool: PgPool,
) {
    let rt = runtime_role_pool(&pool).await;
    let state = CommsRestState::new(PgMailStore::new(rt), None, None)
        .with_mox_webhook_secret(Some(SECRET.to_owned()));

    let exact = format!("Bearer {SECRET}");
    let delta_256 = format!("{exact}{}", "x".repeat(256));
    let shorter = &exact[..exact.len() - 1];
    let longer = format!("{exact}x");
    let wrong_scheme = format!("Basic {SECRET}");

    for presented in [delta_256, shorter.to_owned(), longer, wrong_scheme] {
        let (status, _) =
            post_webhook(router(state.clone()), Some(&presented), incoming_payload()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    let (status, body) = post_webhook(router(state), Some(&exact), incoming_payload()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ingested"], false);
}
