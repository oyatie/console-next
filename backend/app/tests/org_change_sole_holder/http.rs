// SPDX-License-Identifier: LicenseRef-Proprietary
use super::Keys;
use console_kernel_core::{OrgId, UserId};
use console_orgchange_adapter_postgres::PgOrgChangeStore;
use console_orgchange_domain::StepDecisionCommand;
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_request_context::scope_org;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
    soft_passkey::{SoftKey, passkey_service},
};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;
#[path = "../../src/wiring/orgchange_sole_holder.rs"]
mod implementation;
use super::{org_change_fixtures, person_fixtures};
#[path = "support.rs"]
mod support;
use support::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn http_offers_bound_consent_and_persists_each_step_receipt(pool: PgPool) {
    let mut w = world(&pool).await;
    let keys = Keys::generate();
    let token = keys.token(&pool, w.actor, w.org, &["SUPER_ADMIN"]).await;
    let rt = runtime_role_pool(&pool).await;
    let path = format!("/api/v1/org-changes/{}", w.id);
    for (index, step) in w.steps.clone().into_iter().enumerate() {
        let (status, offer) = send(&rt, &keys, "GET", &path, &token, None, None).await;
        assert_eq!(status, StatusCode::OK, "{offer}");
        let consent = &offer["sole_holder_decision"];
        assert_eq!(consent["step_id"], step.to_string());
        assert_eq!(consent["expected_version"], offer["version"]);
        assert_eq!(consent["payload_hash"].as_str().unwrap().len(), 64);
        assert_eq!(consent["notice_count"], 1);
        assert!(consent["review_due_at"].is_string());
        assert!(consent.get("recipients").is_none());
        let command = command_for_consent(&pool, &mut w, consent.clone()).await;
        let url = format!("{path}/approval-steps/{step}/decision");
        let body = json!({"decision":"APPROVED", "expected_version":consent["expected_version"], "step_up":command.step_up});
        let key = Uuid::new_v4().to_string();
        let (status, done) = send(
            &rt,
            &keys,
            "POST",
            &url,
            &token,
            Some(body.clone()),
            Some(&key),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{done}");
        assert_eq!(
            done["status"],
            if index == 3 {
                "APPROVED"
            } else {
                "IN_APPROVAL"
            }
        );
        assert!(done["sole_holder_exception"]["id"].is_string());
        assert_eq!(done["sole_holder_exception"]["notice_count"], 1);
        assert_eq!(done["sole_holder_decision"].is_null(), index == 3);
        let before = business_snapshot(&pool, &w).await;
        let (status, reloaded) = send(&rt, &keys, "GET", &path, &token, None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            reloaded["sole_holder_exception"],
            done["sole_holder_exception"]
        );
        let _ = send(&rt, &keys, "POST", &url, &token, Some(body), Some(&key)).await;
        assert_eq!(business_snapshot(&pool, &w).await, before);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_http_step_up_is_a_401_without_business_effects(pool: PgPool) {
    let mut w = world(&pool).await;
    let keys = Keys::generate();
    let token = keys.token(&pool, w.actor, w.org, &["SUPER_ADMIN"]).await;
    let rt = runtime_role_pool(&pool).await;
    let mut command = command(&pool, &mut w).await;
    command.step_up.as_mut().unwrap()["binding"]["payload_hash"] = json!("b".repeat(64));
    let before = business_snapshot(&pool, &w).await;
    for (language, expected) in [("en", "Verify again"), ("ko", "다시 본인 확인")] {
        let (status, body) = send_language(&rt, &keys, "POST", &format!("/api/v1/org-changes/{}/approval-steps/{}/decision",w.id,w.steps[0]), &token,
            Some(json!({"decision":"APPROVED","expected_version":command.expected_version,"step_up":command.step_up})), Some(&Uuid::new_v4().to_string()), language).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["error"]["code"], "step_up_failed");
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains(expected),
            "{body}"
        );
        assert_eq!(business_snapshot(&pool, &w).await, before);
    }
}

async fn send(
    pool: &PgPool,
    keys: &Keys,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
    key: Option<&str>,
) -> (StatusCode, Value) {
    send_language(pool, keys, method, path, token, body, key, "en").await
}

#[allow(clippy::too_many_arguments)]
async fn send_language(
    pool: &PgPool,
    keys: &Keys,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
    key: Option<&str>,
    language: &str,
) -> (StatusCode, Value) {
    use axum::body::{Body, to_bytes};
    use console_app::{AppConfig, AppState, DatabaseDependency, build_router};
    use http::Request;
    use tower::ServiceExt;
    let state = AppState::new(
        AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", "api".to_owned()),
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
            ("CONSOLE_JWT_ISSUER", super::ISSUER.to_owned()),
            ("CONSOLE_JWT_AUDIENCE", super::AUDIENCE.to_owned()),
            ("CONSOLE_JWT_PUBLIC_KEY_PEM", keys.public_pem.clone()),
            ("CONSOLE_JWT_PRIVATE_KEY_PEM", keys.private_pem.clone()),
            ("CONSOLE_WEBAUTHN_RP_ID", "example.com".to_owned()),
            (
                "CONSOLE_WEBAUTHN_RP_ORIGIN",
                "https://auth.example.com".to_owned(),
            ),
        ])
        .unwrap(),
        DatabaseDependency::Postgres(pool.clone()),
    )
    .unwrap();
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("accept-language", language)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"));
    if let Some(key) = key {
        request = request.header("idempotency-key", key);
    }
    let response = build_router(state)
        .oneshot(
            request
                .body(
                    body.map(|b| Body::from(b.to_string()))
                        .unwrap_or_else(Body::empty),
                )
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}

#[cfg(feature = "notifications")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn notices_are_localized_on_flat_grouped_and_mark_read_responses(pool: PgPool) {
    let mut w = world(&pool).await;
    let keys = Keys::generate();
    let token = keys.token(&pool, w.actor, w.org, &["SUPER_ADMIN"]).await;
    let body = command(&pool, &mut w).await;
    scope_org(
        w.org,
        w.store.decide_step_command(w.actor, w.id, w.steps[0], body),
    )
    .await
    .unwrap();
    let rt = runtime_role_pool(&pool).await;
    for (language, expected) in [("en", "follow-up review"), ("ko", "사후 검토")] {
        for path in [
            "/api/v1/me/notifications",
            "/api/v1/me/notifications/by-object",
        ] {
            let (status, page) =
                send_language(&rt, &keys, "GET", path, &token, None, None, language).await;
            assert_eq!(status, StatusCode::OK, "{page}");
            let item = if path.ends_with("by-object") {
                &page["items"][0]["latest"]
            } else {
                &page["items"][0]
            };
            assert!(item["text"].as_str().unwrap().contains(expected), "{item}");
            for verb in ["read", "unread"] {
                let (status, notice) = send_language(
                    &rt,
                    &keys,
                    "POST",
                    &format!(
                        "/api/v1/me/notifications/{}/{verb}",
                        item["id"].as_str().unwrap()
                    ),
                    &token,
                    None,
                    Some(&Uuid::new_v4().to_string()),
                    language,
                )
                .await;
                assert_eq!(status, StatusCode::OK, "{notice}");
                assert!(
                    notice["text"].as_str().unwrap().contains(expected),
                    "{notice}"
                );
            }
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn offer_is_viewer_specific_and_hidden_when_an_independent_holder_exists(pool: PgPool) {
    let w = world(&pool).await;
    let keys = Keys::generate();
    let actor = keys.token(&pool, w.actor, w.org, &["SUPER_ADMIN"]).await;
    let reader = seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "reader").await;
    person_fixtures::bind_user_to_distinct_person(&pool, reader).await;
    org_change_fixtures::grant_org_levels(&pool, reader, &["view"]).await;
    let viewer = keys.token(&pool, reader, w.org, &["EXECUTIVE"]).await;
    let rt = runtime_role_pool(&pool).await;
    let path = format!("/api/v1/org-changes/{}", w.id);
    let (status, offered) = send(&rt, &keys, "GET", &path, &actor, None, None).await;
    assert_eq!(status, StatusCode::OK, "{offered}");
    assert!(offered["sole_holder_decision"]["step_id"].is_string());
    let (status, detail) = send(&rt, &keys, "GET", &path, &viewer, None, None).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(detail["sole_holder_decision"].is_null());
    org_change_fixtures::grant_org_approve(&pool, reader).await;
    let actor = keys.token(&pool, w.actor, w.org, &["SUPER_ADMIN"]).await;
    let (status, detail) = send(&rt, &keys, "GET", &path, &actor, None, None).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert!(detail["sole_holder_decision"].is_null());
}

async fn business_snapshot(pool: &PgPool, world: &World) -> Value {
    let mut snapshot = support::snapshot(pool, world).await;
    // HTTP security audits record refusals; they are not business effects.
    snapshot.as_array_mut().unwrap().remove(4);
    snapshot
}
