// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_platform_auth_rest::{ADMIN_CREDENTIAL_RESET_PATH, ADMIN_OTP_ISSUE_PATH};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn delegated_session_cannot_issue_account_credentials(owner: PgPool) {
    refuses_recovery(owner, ADMIN_OTP_ISSUE_PATH).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn delegated_session_cannot_reset_account_credentials(owner: PgPool) {
    refuses_recovery(owner, ADMIN_CREDENTIAL_RESET_PATH).await;
}

async fn refuses_recovery(owner: PgPool, path: &str) {
    let home = seed_org(&owner, "parent").await;
    let subsidiary = seed_org(&owner, "subsidiary").await;
    let actor = seed_user(&owner, home).await;
    let group = seed_group(&owner).await;
    seed_group_admin_grant(&owner, group, actor).await;
    let rt = runtime_role_pool(&owner).await;
    let keys = keypair();
    let issuer = JwtIssuer::from_es256_pem(
        settings(),
        keys.private_pem.as_bytes(),
        keys.public_pem.as_bytes(),
    )
    .unwrap();
    let verifier =
        JwtVerifier::from_es256_public_pem(settings(), keys.public_pem.as_bytes()).unwrap();
    let app = router(state_with_keys(rt.clone(), &keys));
    console_platform_test_support::seed_passkey(&owner, OrgId::from_uuid(home), actor).await;
    let source = mint_actor_token(&rt, &issuer, actor, OrgId::from_uuid(home)).await;

    // Delegation remains valid for ordinary tenant operations, including the actor's home company.
    for org in [home, subsidiary] {
        seed_group_membership(&owner, group, org).await;
        let target = seed_user(&owner, org).await;
        sqlx::query("UPDATE users SET roles='{}' WHERE id=$1")
            .bind(target.as_uuid())
            .execute(&owner)
            .await
            .unwrap();
        console_platform_auth::RefreshTokenStore
            .issue_family(
                &rt,
                *target.as_uuid(),
                OrgId::from_uuid(org),
                OffsetDateTime::now_utc(),
                Duration::hours(1),
            )
            .await
            .unwrap();
        console_platform_provisioning::BootstrapCredentialStore
            .issue_for_zero_credential_user(
                &rt,
                None,
                *target.as_uuid(),
                OrgId::from_uuid(org),
                OffsetDateTime::now_utc(),
                Duration::hours(1),
            )
            .await
            .unwrap();
        if path == ADMIN_CREDENTIAL_RESET_PATH {
            console_platform_test_support::seed_passkey(&owner, OrgId::from_uuid(org), target)
                .await;
        }
        let (status, body) = post_tenant_context(app.clone(), &source, org).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let token = body["access_token"].as_str().unwrap();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        console_platform_request_context::resolve_principal(&verifier, &rt, &headers)
            .await
            .expect("delegation must still authorize ordinary tenant operations");
        let before = credential_state(&owner, *target.as_uuid()).await;
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({"user_id": target.as_uuid()}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "forbidden", "{body}");
        assert_eq!(
            body["error"]["message"],
            "delegated sessions cannot manage account credentials or consent"
        );
        assert_eq!(credential_state(&owner, *target.as_uuid()).await, before);
        let live: bool = sqlx::query_scalar(
            "SELECT bool_and(consumed_at IS NULL AND revoked_at IS NULL) FROM auth_bootstrap_credentials WHERE user_id=$1",
        ).bind(target.as_uuid()).fetch_one(&owner).await.unwrap();
        assert!(live, "refusal must preserve the existing sign-in code");
    }
}

async fn credential_state(owner: &PgPool, user: Uuid) -> (i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1), \
         (SELECT count(*) FROM auth_bootstrap_credentials WHERE user_id=$1), \
         (SELECT count(*) FROM auth_refresh_token_families WHERE user_id=$1 AND revoked_at IS NOT NULL), \
         (SELECT count(*) FROM audit_events WHERE action IN ('auth.bootstrap.issue', 'auth.otp.issue', 'auth.refresh.revoke_all'))",
    )
    .bind(user)
    .fetch_one(owner)
    .await
    .unwrap()
}
