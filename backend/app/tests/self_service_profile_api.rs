// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "support/self_service_profile_seed.rs"]
mod seed;
#[path = "support/self_service_harness.rs"]
mod support;

use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_hr_adapter_postgres::digest::sha256_hex;
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_test_support::soft_passkey::passkey_service;
use http::{StatusCode, header};
use seed::seed_profile_fixture;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{call_json, gen_keys, role_pool};
use uuid::Uuid;

fn app_router(pool: PgPool, priv_pem: String, pub_pem: String) -> axum::Router {
    let cfg = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".into()),
        ("CONSOLE_JWT_ISSUER", "console-platform-auth".into()),
        ("CONSOLE_JWT_AUDIENCE", "console-api".into()),
        ("CONSOLE_JWT_PRIVATE_KEY_PEM", priv_pem),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM", pub_pem),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".into()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "https://auth.example.com".into(),
        ),
    ])
    .unwrap();
    build_router(AppState::new(cfg, DatabaseDependency::Postgres(pool)).unwrap())
}

async fn reveal_with_binding(
    pool: &PgPool,
    app: axum::Router,
    tok: &str,
    user_id: Uuid,
    target_id: Uuid,
    key: &mut console_platform_test_support::soft_passkey::SoftKey,
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
        Some(json!({"field": "PHONE", "step_up": {"binding": binding, "assertion": {"ceremony_id": start.ceremony_id, "credential": key.assert(&ch).unwrap()}}})),
        &[],
    )
    .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn screen6_me_profile_reveal_change_request_certificates_and_address_ref(pool: PgPool) {
    let (priv_pem, pub_pem) = gen_keys();
    let mut fx = seed_profile_fixture(&pool, &priv_pem, &pub_pem).await;
    let app = app_router(role_pool(&pool, "console_rt").await, priv_pem, pub_pem);

    // 1. /api/v1/users/me includes 3 extras; /access/people/{id} omits them.
    let (_, _, me) = call_json(
        app.clone(),
        "GET",
        "/api/v1/users/me",
        Some(&fx.tok_a),
        None,
        &[],
    )
    .await;
    assert_eq!(me["employee_hire_date"], "2024-03-01");
    assert_eq!(me["employee_employment_status"], "ACTIVE");
    assert_eq!(me["employee_grade"], "Senior");
    let (st, _, dir) = call_json(
        app.clone(),
        "GET",
        &format!("/api/v1/access/people/{}", fx.user_a.as_uuid()),
        Some(&fx.tok_admin),
        None,
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{dir}");
    assert!(dir.get("employee_grade").is_none());

    // 2. /api/v1/me/profile masked read, unlinked 403, PATCH immediate fields, refuse masked & address.
    assert_eq!(
        call_json(
            app.clone(),
            "GET",
            "/api/v1/me/profile",
            Some(&fx.tok_unlinked),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (st, _, prof) = call_json(
        app.clone(),
        "GET",
        "/api/v1/me/profile",
        Some(&fx.tok_a),
        None,
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{prof}");
    assert_eq!(prof["address_masked"], "Seoul Gangnam Yeoksam");
    assert_eq!(prof["bank_account_registered"], false);
    assert!(prof["phone_masked"].as_str().unwrap().contains("•"));
    assert_eq!(
        call_json(
            app.clone(),
            "PATCH",
            "/api/v1/me/profile",
            Some(&fx.tok_a),
            Some(json!({"phone": "010-••••-5678"})),
            &[]
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call_json(
            app.clone(),
            "PATCH",
            "/api/v1/me/profile",
            Some(&fx.tok_a),
            Some(json!({"address": "secret"})),
            &[]
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (st, _, upd) = call_json(app.clone(), "PATCH", "/api/v1/me/profile", Some(&fx.tok_a), Some(json!({"phone": "010-9999-8888", "emergency_contacts": [{"name": "KimFamily", "relation": "SPOUSE", "phone": "010-1111-2222", "contact_notified": true}]})), &[]).await;
    assert_eq!(st, StatusCode::OK, "{upd}");
    assert_eq!(upd["emergency_contacts_registered"], true);

    // 3. /api/v1/me/profile/reveal: step-up, Cache-Control, self_read exclusion, 429 rate limit.
    let (st, _, b) = call_json(
        app.clone(),
        "POST",
        "/api/v1/me/profile/reveal",
        Some(&fx.tok_a),
        Some(json!({"field": "PHONE"})),
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(b["error"]["code"], "step_up_required");
    let (st, _, b) = reveal_with_binding(
        &pool,
        app.clone(),
        &fx.tok_a,
        *fx.user_a.as_uuid(),
        Uuid::new_v4(),
        &mut fx.key,
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(b["error"]["code"], "passkey_step_up_failed");
    let (st, hdrs, rev) = reveal_with_binding(
        &pool,
        app.clone(),
        &fx.tok_a,
        *fx.user_a.as_uuid(),
        fx.emp_a,
        &mut fx.key,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{rev}");
    assert_eq!(
        hdrs.get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok()),
        Some("private, no-store")
    );
    assert_eq!(rev["value"], "+821099998888");
    let (_, _, access_log) = call_json(
        app.clone(),
        "GET",
        "/api/v1/me/access-log",
        Some(&fx.tok_a),
        None,
        &[],
    )
    .await;
    assert!(
        !access_log["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["action"].as_str().unwrap_or("").contains("self_reveal"))
    );
    let self_audit_count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND actor = $2 AND action = 'employee.self_reveal' AND after_snap->>'self_read' = 'true'")
        .bind(fx.org_a.as_uuid()).bind(fx.user_a.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(self_audit_count, 1);

    for _ in 0..30 {
        sqlx::query("INSERT INTO audit_events (id, org_id, actor, action, target_type, target_id, trace_id, span_id, occurred_at) VALUES (gen_random_uuid(), $1, $2, 'employee.self_reveal', 'employee', $3, 't', 's', now())")
            .bind(fx.org_a.as_uuid()).bind(fx.user_a.as_uuid()).bind(fx.emp_a.to_string()).execute(&pool).await.unwrap();
    }
    let (st, _, b) = reveal_with_binding(
        &pool,
        app.clone(),
        &fx.tok_a,
        *fx.user_a.as_uuid(),
        fx.emp_a,
        &mut fx.key,
    )
    .await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "{b}");
    assert_eq!(b["error"]["code"], "reveal_rate_limited");

    // 4. Change requests + 5. certificates + address-search.
    assert_eq!(call_json(app.clone(), "POST", "/api/v1/me/profile/change-requests", Some(&fx.tok_a), Some(json!({"field": "bank_account_registered", "bank_account_registered": true, "account_number": "123"})), &[]).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    let (st, _, cr) = call_json(
        app.clone(),
        "POST",
        "/api/v1/me/profile/change-requests",
        Some(&fx.tok_a),
        Some(json!({"field": "bank_account_registered", "bank_account_registered": true})),
        &[],
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{cr}");
    assert_eq!(
        call_json(
            app.clone(),
            "POST",
            "/api/v1/me/profile/change-requests",
            Some(&fx.tok_a),
            Some(json!({"field": "bank_account_registered", "bank_account_registered": true})),
            &[]
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let cr_id: Uuid = cr["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        call_json(
            app.clone(),
            "POST",
            &format!("/api/v1/change-requests/{cr_id}/decide"),
            Some(&fx.tok_admin),
            Some(json!({"decision": "APPLY", "reason_code": "USER_REQUEST"})),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, _, prof2) = call_json(
        app.clone(),
        "GET",
        "/api/v1/me/profile",
        Some(&fx.tok_a),
        None,
        &[],
    )
    .await;
    assert_eq!(prof2["bank_account_registered"], true);

    assert_eq!(call_json(app.clone(), "PUT", "/api/v1/hr/certificate-settings", Some(&fx.tok_admin), Some(json!({"legal_entity_id": fx.entity_a, "prefix": "CERT", "width": 6, "seal_text": "CEO Seal", "expected_version": 0})), &[]).await.0, StatusCode::OK);
    let (st, _, cert) = call_json(app.clone(), "POST", "/api/v1/me/certificates", Some(&fx.tok_a), Some(json!({"kind": "EMPLOYMENT", "items": ["period", "position"], "purpose": "Bank submit"})), &[("Idempotency-Key", &Uuid::new_v4().to_string())]).await;
    assert_eq!(st, StatusCode::CREATED, "{cert}");
    let cert_id = cert["id"].as_str().unwrap();
    assert_eq!(
        call_json(
            app.clone(),
            "GET",
            &format!("/api/v1/me/certificates/{cert_id}"),
            Some(&fx.tok_a),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call_json(
            app.clone(),
            "GET",
            &format!("/api/v1/me/certificates/{cert_id}"),
            Some(&fx.tok_b),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call_json(
            app.clone(),
            "GET",
            "/api/v1/me/certificates",
            Some(&fx.tok_unlinked),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_ne!(
        call_json(
            app.clone(),
            "GET",
            "/api/v1/ref/address-search?keyword=Teheran",
            Some(&fx.tok_a),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call_json(
            app.clone(),
            "GET",
            "/api/v1/ref/address-search?keyword=test",
            None,
            None,
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
