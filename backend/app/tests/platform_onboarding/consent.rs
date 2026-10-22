// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn platform_write_requires_current_personal_consent(super_pool: PgPool) {
    let keys = gen_keys();
    let platform_admin = UserId::new();
    let _admin_key = seed_platform_admin(&super_pool, platform_admin).await;
    let runtime_pool = console_rt_pool(&super_pool).await;
    let service = build_router(app_state(runtime_pool.clone(), &keys));
    let platform_token = issue_token(
        &runtime_pool,
        &keys,
        platform_admin,
        OrgId::platform(),
        vec!["SUPER_ADMIN".to_owned()],
        true,
    )
    .await;
    let family: uuid::Uuid =
        sqlx::query_scalar("SELECT id FROM auth_refresh_token_families WHERE user_id=$1")
            .bind(platform_admin.as_uuid())
            .fetch_one(&super_pool)
            .await
            .unwrap();
    sqlx::query("UPDATE auth_refresh_token_families SET privacy_acceptance=NULL WHERE id=$1")
        .bind(family)
        .execute(&super_pool)
        .await
        .unwrap();
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations")
        .fetch_one(&super_pool)
        .await
        .unwrap();
    let denied = service
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/platform/orgs")
                .header(header::AUTHORIZATION, format!("Bearer {platform_token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"slug":"no-consent","name":"Refused tenant"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let denied: Value =
        serde_json::from_slice(&to_bytes(denied.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(denied["error"]["code"], "privacy_consent_required");
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations")
        .fetch_one(&super_pool)
        .await
        .unwrap();
    assert_eq!(
        after, before,
        "refused platform write must create no tenant"
    );
    console_platform_test_support::seed_session_consent(&super_pool, family).await;
    let allowed = service
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/platform/orgs")
                .header(header::AUTHORIZATION, format!("Bearer {platform_token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"slug":"with-consent","name":"Accepted tenant"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::CREATED);
}
