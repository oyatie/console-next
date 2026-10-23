// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

/// An existing app session must accept the exact current documents before any People write.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn app_session_without_privacy_consent_cannot_create_employee(pool: PgPool) {
    let keys = keys();
    let org = OrgId::one();
    let user = UserId::new();
    seed_user(&pool, org, user).await;
    let branch = seed_branch(&pool, org, "Privacy branch").await;
    let service = build_router(
        app_state(
            runtime_role_pool(&pool).await,
            leave_command_role_pool(&pool).await,
            &keys,
        )
        .unwrap(),
    );
    let token = unaccepted_bearer(&pool, &keys, org, user).await;
    let before = people_write_counts(&pool, org).await;
    let body = create_body(
        branch,
        "PRIVACY-001",
        "privacy-create",
        "010-1234-5678",
        "동의 확인",
    );
    let denied = post(service.clone(), EMPLOYEES_PATH, &token, body.clone()).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{:?}", denied.json);
    assert_eq!(denied.json["error"]["code"], "privacy_consent_required");
    assert_eq!(people_write_counts(&pool, org).await, before);
    assert_no_employee_writes(&pool, org, "PRIVACY-001", "privacy-create").await;

    let documents = get(service.clone(), "/api/v1/onboarding/terms", &token).await;
    assert_eq!(documents.status, StatusCode::OK, "{:?}", documents.json);
    let d = documents.json;
    let accepted = post(
        service.clone(),
        "/api/v1/auth/privacy-consent/accept",
        &token,
        json!({"privacy": {"version": d["privacy"]["version"], "sha256": d["privacy"]["sha256"]},
            "terms": {"version": d["version"], "sha256": d["sha256"]},
            "privacy_collection": true, "terms_of_service": true}),
    )
    .await;
    assert_eq!(accepted.status, StatusCode::OK, "{:?}", accepted.json);
    let allowed = post(service.clone(), EMPLOYEES_PATH, &token, body.clone()).await;
    assert_eq!(allowed.status, StatusCode::CREATED, "{:?}", allowed.json);

    // A new sign-in restores hash-bound acceptance once from the durable audit.
    let next_session = unaccepted_bearer(&pool, &keys, org, user).await;
    let repeated = post(service.clone(), EMPLOYEES_PATH, &next_session, body.clone()).await;
    assert_eq!(repeated.status, StatusCode::OK, "{:?}", repeated.json);
    sqlx::query("INSERT INTO terms_documents (version,kind,body,published_at,policy_url,review_pending) SELECT 'privacy-next-test',kind,body || E'\\nUpdated fixture',clock_timestamp(),policy_url,review_pending FROM terms_documents WHERE version=$1")
        .bind(d["privacy"]["version"].as_str().unwrap()).execute(&pool).await.unwrap();
    let before_reconsent = people_write_counts(&pool, org).await;
    let stale = post(service.clone(), EMPLOYEES_PATH, &next_session, body).await;
    assert_eq!(stale.status, StatusCode::FORBIDDEN, "{:?}", stale.json);
    assert_eq!(stale.json["error"]["code"], "privacy_consent_required");
    assert_eq!(people_write_counts(&pool, org).await, before_reconsent);
    let credential_write = post(
        service,
        "/api/v1/auth/passkey/register/start",
        &next_session,
        json!({}),
    )
    .await;
    assert_eq!(
        credential_write.status,
        StatusCode::FORBIDDEN,
        "{:?}",
        credential_write.json
    );
    assert_eq!(
        credential_write.json["error"]["code"],
        "privacy_consent_required"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_documents_are_readable_and_hash_bound_before_acceptance(pool: PgPool) {
    sqlx::query("INSERT INTO terms_documents (version,body,published_at) VALUES ('service-read-test','Exact service document from store',now())").execute(&pool).await.unwrap();
    let keys = keys();
    let org = OrgId::one();
    let user = UserId::new();
    seed_user(&pool, org, user).await;
    let service = build_router(
        app_state(
            runtime_role_pool(&pool).await,
            leave_command_role_pool(&pool).await,
            &keys,
        )
        .unwrap(),
    );
    let token = unaccepted_bearer(&pool, &keys, org, user).await;
    let result = get(service, "/api/v1/onboarding/terms", &token).await;
    assert_eq!(result.status, StatusCode::OK, "{:?}", result.json);
    assert_eq!(result.json["version"], "service-read-test");
    assert_eq!(result.json["body"], "Exact service document from store");
    assert!(
        result.json["privacy"]["body"]
            .as_str()
            .unwrap()
            .contains("제2부. 회사가 수탁자로서 처리하는 개인정보")
    );
    let body = result.json["privacy"]["body"].as_str().unwrap();
    for editor_text in [
        "게시 전",
        "<a id=",
        "【",
        "privacy-policy-facts",
        "console-next",
        "현재 없습니다",
        "# ",
        "|---",
    ] {
        assert!(
            !body.contains(editor_text),
            "reader document contains {editor_text}"
        );
    }
    assert_eq!(result.json["privacy"]["review_pending"], true);
    let hash: String = sqlx::query_scalar("SELECT sha256 FROM terms_documents WHERE version=$1")
        .bind(result.json["privacy"]["version"].as_str().unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(result.json["privacy"]["sha256"], hash);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_documents_refuse_writes_even_with_cached_acceptance(pool: PgPool) {
    let keys = keys();
    let org = OrgId::one();
    let user = UserId::new();
    seed_user(&pool, org, user).await;
    let branch = seed_branch(&pool, org, "Unpublished branch").await;
    let token = bearer(&pool, &keys, org, user, &["SUPER_ADMIN"]).await;
    let service = build_router(
        app_state(
            runtime_role_pool(&pool).await,
            leave_command_role_pool(&pool).await,
            &keys,
        )
        .unwrap(),
    );
    // Only this disposable test database loses its global documents.
    sqlx::query("TRUNCATE terms_documents CASCADE")
        .execute(&pool)
        .await
        .unwrap();
    let before = people_write_counts(&pool, org).await;
    let denied = post(
        service.clone(),
        EMPLOYEES_PATH,
        &token,
        create_body(
            branch,
            "UNPUBLISHED-001",
            "unpublished-create",
            "010-1234-5678",
            "문서 미공개",
        ),
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{:?}", denied.json);
    assert_eq!(denied.json["error"]["code"], "privacy_consent_required");
    assert_eq!(people_write_counts(&pool, org).await, before);
    let status = post(
        service,
        "/api/v1/auth/privacy-consent/status",
        &token,
        json!({}),
    )
    .await;
    assert_eq!(status.status, StatusCode::CONFLICT, "{:?}", status.json);
    assert_eq!(status.json["error"]["code"], "terms_not_published");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn enrollment_can_read_documents_but_cannot_accept_tenant_terms(pool: PgPool) {
    let keys = keys();
    let org = OrgId::one();
    let user = UserId::new();
    seed_user(&pool, org, user).await;
    let service = build_router(
        app_state(
            runtime_role_pool(&pool).await,
            leave_command_role_pool(&pool).await,
            &keys,
        )
        .unwrap(),
    );
    let issue = console_platform_provisioning::BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &pool,
            None,
            *user.as_uuid(),
            org,
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap();
    let redeemed = post(
        service.clone(),
        "/api/v1/auth/otp/redeem",
        "",
        json!({ "otp": issue.token.as_str() }),
    )
    .await;
    assert_eq!(redeemed.status, StatusCode::OK, "{:?}", redeemed.json);
    let token = redeemed.json["access_token"].as_str().unwrap();
    let documents = get(service.clone(), "/api/v1/onboarding/terms", token).await;
    assert_eq!(documents.status, StatusCode::OK, "{:?}", documents.json);
    let denied = post(
        service,
        "/api/v1/onboarding/terms",
        token,
        json!({"version": documents.json["version"], "sha256": documents.json["sha256"]}),
    )
    .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{:?}", denied.json);
    assert_eq!(denied.json["error"]["code"], "passkey_required");
    let acceptances: i64 = sqlx::query_scalar("SELECT count(*) FROM tenant_terms_acceptances")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(acceptances, 0);
}

async fn unaccepted_bearer(pool: &PgPool, keys: &Keys, org: OrgId, user: UserId) -> String {
    let issuer = JwtIssuer::from_es256_pem(
        JwtSettings {
            issuer: TEST_ISSUER.to_owned(),
            audience: TEST_AUDIENCE.to_owned(),
            access_token_ttl: Duration::minutes(15),
        },
        keys.private_pem.as_bytes(),
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    let now = OffsetDateTime::now_utc();
    let family = console_platform_auth::RefreshTokenStore
        .issue_family(pool, *user.as_uuid(), org, now, Duration::hours(1))
        .await
        .unwrap();
    issuer
        .issue_session_access_token(
            AccessTokenInput {
                subject: user,
                org_id: org,
                roles: vec!["SUPER_ADMIN".into()],
                branches: vec![],
                platform: false,
                support: None,
                read_only: false,
                display_name: None,
                feature_grants: vec![],
                authz_subject_version: 0,
                authz_policy_version: 0,
                session_generation: 0,
                issued_at: now,
            },
            None,
            vec![],
            family.family_id,
            family.expires_at,
        )
        .unwrap()
}

#[path = "../support/terms.rs"]
mod terms;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ordinary_terms_fixture_preserves_minted_personal_consent(pool: PgPool) {
    let org = OrgId::one();
    let user = UserId::new();
    seed_user(&pool, org, user).await;
    let _token = bearer(&pool, &keys(), org, user, &["SUPER_ADMIN"]).await;
    let acceptance: Value = sqlx::query_scalar(
        "SELECT privacy_acceptance FROM auth_refresh_token_families WHERE user_id=$1",
    )
    .bind(user.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    let document = terms::publish(&pool).await;
    assert_eq!(document, acceptance["terms"]);
    assert_eq!(terms::publish(&pool).await, document);
}
