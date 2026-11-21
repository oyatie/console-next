// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/self_service_profile_seed.rs"]
mod seed;
#[path = "support/self_service_harness.rs"]
mod support;

#[path = "self_service_profile_api/phone_edge_cases.rs"]
mod phone_edge_cases;
#[path = "self_service_profile_api/profile_and_reveal.rs"]
mod profile_and_reveal;
#[path = "self_service_profile_api/requests_certs_ref.rs"]
mod requests_certs_ref;

use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_hr_adapter_postgres::digest::sha256_hex;
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::call_json;
use uuid::Uuid;

pub(crate) fn app_router(pool: PgPool, priv_pem: String, pub_pem: String) -> axum::Router {
    let cfg = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".into()),
        ("CONSOLE_JWT_ISSUER", "console-platform-auth".into()),
        ("CONSOLE_JWT_AUDIENCE", "console-api".into()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", pub_pem),
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", priv_pem),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".into()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "https://auth.example.com".into(),
        ),
    ])
    .unwrap();
    build_router(AppState::new(cfg, DatabaseDependency::Postgres(pool)).unwrap())
}

pub(crate) async fn reveal_with_binding(
    pool: &PgPool,
    app: axum::Router,
    tok: &str,
    user_id: Uuid,
    target_id: Uuid,
    key: &mut SoftKey,
) -> (StatusCode, http::HeaderMap, Value) {
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::PiiReveal,
        target_id,
        sha256_hex(b"SELF_REVEAL:PHONE"),
    );
    let start = passkey_service()
        .start_mobile_step_up(pool, user_id, binding.clone())
        .await
        .unwrap();
    let mut ch = serde_json::to_value(start.challenge).unwrap();
    ch["publicKey"]["allowCredentials"] =
        json!([{"type": "public-key", "id": key.credential_id()}]);
    call_json(
        app,
        "POST",
        "/api/v1/me/profile/reveal",
        Some(tok),
        Some(json!({
            "field": "PHONE",
            "step_up": {
                "binding": binding,
                "assertion": {
                    "ceremony_id": start.ceremony_id,
                    "credential": key.assert(&ch).unwrap(),
                }
            }
        })),
        &[],
    )
    .await
}
