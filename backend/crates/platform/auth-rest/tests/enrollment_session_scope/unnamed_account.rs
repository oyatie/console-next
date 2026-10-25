// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unnamed_platform_admin_can_enroll_with_account_identifier(owner: PgPool) {
    console_platform_test_support::seed_consent_documents(&owner).await;
    sqlx::query("DELETE FROM users WHERE org_id=$1 AND roles @> ARRAY['SUPER_ADMIN']::text[]")
        .bind(OrgId::platform().as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    let store = BootstrapCredentialStore;
    store
        .seed_cold_start_credential(
            &owner,
            "unnamed-root",
            Duration::hours(1),
            OffsetDateTime::now_utc(),
        )
        .await
        .unwrap();
    let app = router(state(runtime_role_pool(&owner).await));
    let (status, redeemed) = send(
        &app,
        "POST",
        OTP_REDEEM_PATH,
        None,
        Some(json!({"otp": "unnamed-root"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{redeemed}");
    let token = redeemed["access_token"].as_str().unwrap();
    let (_, documents) = send(
        &app,
        "POST",
        PRIVACY_CONSENT_STATUS_PATH,
        Some(token),
        Some(json!({})),
    )
    .await;
    let (status, accepted) = send(&app, "POST", "/api/v1/auth/privacy-consent/accept", Some(token), Some(json!({
        "privacy": documents["privacy"], "terms": documents["terms"], "privacy_collection": true, "terms_of_service": true
    }))).await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    for overrides in [json!({}), json!({"username": "  ", "display_name": "  "})] {
        let (status, started) = send(
            &app,
            "POST",
            "/api/v1/auth/passkey/register/start",
            Some(token),
            Some(overrides),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{started}");
        let user = &started["challenge"]["publicKey"]["user"];
        assert!(!user["name"].as_str().unwrap().trim().is_empty());
        assert_eq!(user["displayName"], user["name"]);
    }
}
