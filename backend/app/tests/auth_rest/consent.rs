// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[path = "consent_compat.rs"]
mod compatibility;

/// Acceptance binds both separate sign-offs to the exact immutable text hashes.
#[sqlx::test(migrator = "MIGRATOR")]
async fn privacy_consent_acceptance_binds_both_exact_documents(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch = seed_branch(&pool, "Document Region", "Document Branch").await;
    let user =
        seed_user_with_branch(&pool, "Document User", "010-1234-0081", "MECHANIC", branch).await;
    let service =
        build_router(app_state(pool.clone(), private_key_pem.to_string(), public_key_pem).unwrap());
    let token = admin_session_via_otp(&service, &pool, user).await;
    let status: Value = post_json(
        service.clone(),
        "/api/v1/auth/privacy-consent/status",
        Some(&token),
        json!({}),
        StatusCode::OK,
    )
    .await;
    let consent = json!({
        "privacy": status["privacy"],
        "terms": status["terms"],
        "privacy_collection": true,
        "terms_of_service": true
    });
    for document in ["privacy", "terms"] {
        let mut mismatched = consent.clone();
        mismatched[document]["sha256"] = json!("0".repeat(64));
        let response = post_raw(
            service.clone(),
            "/api/v1/auth/privacy-consent/accept",
            Some(&token),
            mismatched,
        )
        .await;
        let refusal: Value = response.into_json(StatusCode::CONFLICT).await;
        assert_eq!(refusal["error"]["code"], "terms_text_changed");
        let accepted: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE actor=$1 AND action='privacy.required_accept'",
        )
        .bind(user.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            accepted, 0,
            "a mismatched {document} hash must never be recorded"
        );
    }
    let accepted: Value = post_json(
        service,
        "/api/v1/auth/privacy-consent/accept",
        Some(&token),
        consent.clone(),
        StatusCode::OK,
    )
    .await;
    assert_eq!(accepted["accepted"], true);
    let snapshot: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE actor=$1 AND action='privacy.required_accept'",
    )
    .bind(user.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(snapshot["privacy"], consent["privacy"]);
    assert_eq!(snapshot["terms"], consent["terms"]);
}

/// Initial enrollment requires privacy and terms consent before passkey registration can begin.
#[sqlx::test(migrator = "MIGRATOR")]
async fn first_passkey_enrollment_requires_privacy_terms(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Privacy Region", "Privacy Branch").await;
    let user_id = seed_user_with_branch(
        &pool,
        "Privacy User",
        "010-1234-0016",
        "MECHANIC",
        branch_id,
    )
    .await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            None,
            *user_id.as_uuid(),
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .unwrap();
    let redeem: OtpRedeemResponse = post_json(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issue.token.as_str() }),
        StatusCode::OK,
    )
    .await;
    assert!(redeem.requires_passkey_setup);

    let initial_status: PrivacyConsentStatusResponse = post_json(
        service.clone(),
        "/api/v1/auth/privacy-consent/status",
        Some(&redeem.access_token),
        json!({}),
        StatusCode::OK,
    )
    .await;
    assert!(!initial_status.accepted);
    assert!(initial_status.accepted_at.is_none());
    assert_eq!(
        initial_status.privacy["version"].as_str(),
        Some(initial_status.policy_version.as_str())
    );

    let blocked = post_raw(
        service.clone(),
        "/api/v1/auth/passkey/register/start",
        Some(&redeem.access_token),
        json!({ "username": "privacy.user", "display_name": "Privacy User" }),
    )
    .await;
    let blocked_body: Value = blocked.into_json(StatusCode::FORBIDDEN).await;
    assert_eq!(blocked_body["error"]["code"], "privacy_consent_required");

    let bundled_or_partial_consent = post_raw(
        service.clone(),
        "/api/v1/auth/privacy-consent/accept",
        Some(&redeem.access_token),
        json!({
            "privacy": initial_status.privacy,
            "terms": initial_status.terms,
            "privacy_collection": true,
            "terms_of_service": false
        }),
    )
    .await;
    assert_eq!(bundled_or_partial_consent.status(), StatusCode::BAD_REQUEST);

    let accepted = accept_required_privacy_consent(&service, &redeem.access_token).await;
    assert!(accepted.accepted);
    assert!(accepted.accepted_at.is_some());

    let allowed: RegisterStartResponse = post_json(
        service.clone(),
        "/api/v1/auth/passkey/register/start",
        Some(&redeem.access_token),
        json!({ "username": "privacy.user", "display_name": "Privacy User" }),
        StatusCode::OK,
    )
    .await;
    assert_ne!(allowed.ceremony_id, Uuid::nil());
}

/// Status endpoint under DB fault returns 500, not false-negative accepted: false (P1-9 / P1-4).
#[sqlx::test(migrator = "MIGRATOR")]
async fn privacy_consent_status_returns_500_under_db_fault(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key_pem = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch_id = seed_branch(&pool, "Privacy Fault Region", "Privacy Fault Branch").await;
    let user_id = seed_user_with_branch(
        &pool,
        "Privacy Fault User",
        "010-1234-0017",
        "MECHANIC",
        branch_id,
    )
    .await;
    let service = build_router(
        app_state(
            pool.clone(),
            private_key_pem.to_string(),
            public_key_pem.clone(),
        )
        .unwrap(),
    );

    let issue = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            None,
            *user_id.as_uuid(),
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(24),
        )
        .await
        .unwrap();
    let redeem: OtpRedeemResponse = post_json(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        None,
        json!({ "otp": issue.token.as_str() }),
        StatusCode::OK,
    )
    .await;

    // Missing versioned text must refuse instead of reporting an unaccepted state.
    sqlx::query("DROP TABLE terms_documents CASCADE")
        .execute(&pool)
        .await
        .unwrap();

    let res = post_raw(
        service.clone(),
        "/api/v1/auth/privacy-consent/status",
        Some(&redeem.access_token),
        json!({}),
    )
    .await;
    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
}
