// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

/// N-1's version-only acknowledgement cannot prove acceptance of today's immutable documents.
#[sqlx::test(migrator = "MIGRATOR")]
async fn legacy_consent_refuses_unmappable_text_without_writing(pool: PgPool) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private = signing_key.to_pkcs8_pem(LineEnding::LF).unwrap();
    let public = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .unwrap();
    let branch = seed_branch(&pool, "Legacy Region", "Legacy Branch").await;
    let user =
        seed_user_with_branch(&pool, "Legacy User", "010-1234-0082", "MECHANIC", branch).await;
    let service = build_router(app_state(pool.clone(), private.to_string(), public).unwrap());
    let token = admin_session_via_otp(&service, &pool, user).await;
    let status: Value = post_json(
        service.clone(),
        "/api/v1/auth/privacy-consent/status",
        Some(&token),
        json!({}),
        StatusCode::OK,
    )
    .await;

    // Exact N-1 body, missing version, and either partial upgrade must all require review, never a 422.
    for extra in [
        json!({"policy_version": "kr-pipa-v1-2026-06-25"}),
        json!({}),
        json!({"privacy": status["privacy"]}),
        json!({"terms": status["terms"]}),
    ] {
        let mut body = json!({"privacy_collection": true, "terms_of_service": true});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let response = post_raw(
            service.clone(),
            "/api/v1/auth/privacy-consent/accept",
            Some(&token),
            body,
        )
        .await;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        let refusal: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(refusal["error"]["code"], "terms_text_changed");
    }
    let recorded: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE actor=$1 AND action='privacy.required_accept'",
    )
    .bind(user.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        recorded, 0,
        "legacy acceptance must not be relabelled as current consent"
    );
    let cached: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_refresh_token_families WHERE user_id=$1 AND privacy_acceptance IS NOT NULL")
        .bind(user.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(cached, 0);

    // The same session can recover by reading and accepting both current texts.
    let accepted = accept_required_privacy_consent(&service, &token).await;
    assert!(accepted.accepted);
}
