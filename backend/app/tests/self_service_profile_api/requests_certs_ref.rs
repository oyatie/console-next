// SPDX-License-Identifier: LicenseRef-Proprietary
use http::StatusCode;
use serde_json::json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::app_router;
use super::seed::seed_profile_fixture;
use super::support::{call_json, gen_keys, role_pool};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn screen6_change_requests_attestations_certificates_and_address_search(pool: PgPool) {
    let (priv_pem, pub_pem) = gen_keys();
    let fx = seed_profile_fixture(&pool, &priv_pem, &pub_pem).await;
    let app = app_router(role_pool(&pool, "console_rt").await, priv_pem, pub_pem);

    // 1. Change request for boolean bank_account_registered (reject raw account_number).
    assert_eq!(
        call_json(
            app.clone(),
            "POST",
            "/api/v1/me/profile/change-requests",
            Some(&fx.tok_a),
            Some(json!({"field": "bank_account_registered", "bank_account_registered": true, "account_number": "123"})),
            &[],
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
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
            &[],
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
            &[],
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

    let att = sqlx::query(
        "SELECT old_value, new_value, change_request_id \
         FROM employee_bank_account_attestations WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(fx.org_a.as_uuid())
    .bind(fx.emp_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(att.try_get::<Option<bool>, _>("old_value").unwrap(), None);
    assert!(att.try_get::<bool, _>("new_value").unwrap());
    assert_eq!(
        att.try_get::<Option<Uuid>, _>("change_request_id").unwrap(),
        Some(cr_id)
    );

    // 2. Self-service certificates + tenant isolation.
    assert_eq!(
        call_json(
            app.clone(),
            "PUT",
            "/api/v1/hr/certificate-settings",
            Some(&fx.tok_admin),
            Some(json!({"legal_entity_id": fx.entity_a, "prefix": "CERT", "width": 6, "seal_text": "CEO Seal", "expected_version": 0})),
            &[],
        )
        .await
        .0,
        StatusCode::OK
    );
    let (st, _, cert) = call_json(
        app.clone(),
        "POST",
        "/api/v1/me/certificates",
        Some(&fx.tok_a),
        Some(json!({"kind": "EMPLOYMENT", "items": ["period", "position"], "purpose": "Bank submit"})),
        &[("Idempotency-Key", &Uuid::new_v4().to_string())],
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{cert}");
    let cert_id = cert["id"].as_str().unwrap();
    assert_eq!(
        call_json(
            app.clone(),
            "GET",
            &format!("/api/v1/me/certificates/{cert_id}"),
            Some(&fx.tok_a),
            None,
            &[],
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
            &[],
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
            &[],
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    // 3. Tenant-authenticated address reference search (?q=...).
    assert_eq!(
        call_json(
            app.clone(),
            "GET",
            "/api/v1/ref/address-search?q=Teheran",
            Some(&fx.tok_a),
            None,
            &[],
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call_json(
            app,
            "GET",
            "/api/v1/ref/address-search?q=test",
            None,
            None,
            &[],
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
