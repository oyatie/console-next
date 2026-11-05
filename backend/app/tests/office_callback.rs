// SPDX-License-Identifier: LicenseRef-Proprietary
#![cfg(feature = "office")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use console_app::office::{
    OfficeBlobStore, OfficeConfig, OfficeFuture, OfficeState, StoredBlob, router,
};
use console_platform_test_support::runtime_role_pool;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Default)]
struct Blobs(AtomicUsize);

impl OfficeBlobStore for Blobs {
    fn store_from_url(&self, _: String, _: String) -> OfficeFuture<'_, StoredBlob> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(StoredBlob {
                content_hash: "a".repeat(64),
                byte_size: 16,
            })
        })
    }

    fn presign_get(&self, _: String) -> OfficeFuture<'_, String> {
        panic!("callbacks do not presign downloads")
    }
}

fn signed(secret: &str, claims: Value) -> String {
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

async fn callback(
    app: &Router,
    binding: &str,
    body: Value,
    bearer: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::post(format!("/api/v1/office/callback?ct={binding}"))
        .header("content-type", "application/json");
    if let Some(token) = bearer {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn counts(pool: &PgPool, org: Uuid) -> (i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM document_versions WHERE org_id = $1), (SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'office.document_version.record')")
        .bind(org).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn callback_refusals_use_http_status_and_preserve_versions(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id, slug, name) VALUES ($1, $2, 'Office test')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let rt = runtime_role_pool(&pool).await;
    let blobs = Arc::new(Blobs::default());
    let config = OfficeConfig {
        jwt_secret: Uuid::new_v4().to_string(),
        callback_base_url: "https://console.invalid".to_owned(),
        docserver_url: "https://office.invalid".to_owned(),
    };
    let app = router(OfficeState::new(
        rt.clone(),
        None,
        Some(config.clone()),
        Some(blobs.clone()),
    ));
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let binding = signed(
        &config.jwt_secret,
        json!({"org": org, "doc": "document", "exp": now + 600}),
    );
    let expired_binding = signed(
        &config.jwt_secret,
        json!({"org": org, "doc": "document", "exp": now - 600}),
    );
    let save = signed(
        &config.jwt_secret,
        json!({"status": 2, "key": "session", "url": "https://office.invalid/document", "filetype": "docx"}),
    );
    let expired_save = signed(&config.jwt_secret, json!({"status": 2, "exp": now - 600}));

    for (ct, body, bearer) in [
        ("invalid", json!({"token": save}), None),
        (expired_binding.as_str(), json!({"token": save}), None),
        (binding.as_str(), json!({}), None),
        (
            binding.as_str(),
            json!({"token": "invalid"}),
            Some(save.as_str()),
        ),
        (binding.as_str(), json!({"token": expired_save}), None),
        (binding.as_str(), json!({}), Some("invalid")),
    ] {
        let (status, body) = callback(&app, ct, body, bearer).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body, json!({"error": 1, "code": "invalid_token"}));
        assert_eq!(counts(&pool, org).await, (0, 0));
        assert_eq!(blobs.0.load(Ordering::SeqCst), 0);
    }

    let incomplete = signed(&config.jwt_secret, json!({"status": 2}));
    let (status, body) = callback(&app, &binding, json!({"token": incomplete}), None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body, json!({"error": 1, "code": "validation"}));
    for state in [
        OfficeState::new(rt.clone(), None, None, Some(blobs.clone())),
        OfficeState::new(rt, None, Some(config.clone()), None),
    ] {
        let (status, body) = callback(&router(state), &binding, json!({"token": save}), None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body, json!({"error": 1, "code": "office_not_configured"}));
    }
    assert_eq!(counts(&pool, org).await, (0, 0));
    assert_eq!(blobs.0.load(Ordering::SeqCst), 0);

    for status in [1, 4] {
        let token = signed(&config.jwt_secret, json!({"status": status}));
        assert_eq!(
            callback(&app, &binding, json!({"token": token}), None).await,
            (StatusCode::OK, json!({"error": 0}))
        );
    }
    for status in [2, 6] {
        let token = signed(
            &config.jwt_secret,
            json!({"status": status, "key": format!("session-{status}"), "url": "https://office.invalid/document", "filetype": "docx"}),
        );
        assert_eq!(
            callback(&app, &binding, json!({}), Some(&token)).await,
            (StatusCode::OK, json!({"error": 0}))
        );
        assert_eq!(
            callback(&app, &binding, json!({"token": token}), None).await,
            (StatusCode::OK, json!({"error": 0}))
        );
    }
    assert_eq!(counts(&pool, org).await, (2, 2));
}
