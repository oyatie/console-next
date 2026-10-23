// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

/// Session snapshots change only on issuance/refresh; protected writes still enforce the current texts.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn consent_snapshot_tracks_acceptance_and_new_documents(owner: PgPool) {
    let (app, token, user) = enrollment_session(&owner).await;
    let family = console_platform_auth::RefreshTokenStore
        .issue_family(
            &owner,
            user,
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap();
    let (status, initial) = send(
        &app,
        "POST",
        "/api/v1/auth/token/refresh",
        None,
        Some(json!({"refresh_token": family.token.as_str()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{initial}");
    assert_eq!(initial["privacy_consent_accepted"], false);
    let (_, documents) = send(
        &app,
        "POST",
        PRIVACY_CONSENT_STATUS_PATH,
        Some(&token),
        Some(json!({})),
    )
    .await;
    let (status, accepted) = send(
        &app,
        "POST",
        "/api/v1/auth/privacy-consent/accept",
        Some(&token),
        Some(
            json!({"privacy": documents["privacy"], "terms": documents["terms"],
            "privacy_collection": true, "terms_of_service": true}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["accepted"], true);
    let (status, renewed) = send(
        &app,
        "POST",
        "/api/v1/auth/token/refresh",
        None,
        Some(json!({"refresh_token": initial["refresh_token"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renewed}");
    assert_eq!(renewed["privacy_consent_accepted"], true);
    sqlx::query(
        "UPDATE auth_bootstrap_credentials SET revoked_at=clock_timestamp() WHERE user_id=$1",
    )
    .bind(user)
    .execute(&owner)
    .await
    .unwrap();
    let fresh = BootstrapCredentialStore
        .issue_for_zero_credential_user(
            &owner,
            None,
            user,
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap();
    let (status, signed_in) = send(
        &app,
        "POST",
        OTP_REDEEM_PATH,
        None,
        Some(json!({"otp": fresh.token.as_str()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{signed_in}");
    assert_eq!(signed_in["privacy_consent_accepted"], true);
    let (status, body) = send(
        &app,
        "GET",
        AUTH_PASSKEYS_PATH,
        renewed["access_token"].as_str(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Publish a new required privacy notice; the old JWT cannot authorize a protected write.
    sqlx::query("INSERT INTO terms_documents (version,kind,body,published_at,policy_url,review_pending) SELECT 'session-consent-next',kind,body || E'\\nUpdated',clock_timestamp(),policy_url,review_pending FROM terms_documents WHERE version=$1")
        .bind(documents["privacy"]["version"].as_str().unwrap()).execute(&owner).await.unwrap();
    let (status, body) = send(
        &app,
        "GET",
        AUTH_PASSKEYS_PATH,
        renewed["access_token"].as_str(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "privacy_consent_required");
    let (status, denied) = send(
        &app,
        "POST",
        "/api/v1/auth/passkey/register/start",
        renewed["access_token"].as_str(),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    assert_eq!(denied["error"]["code"], "privacy_consent_required");
    let (status, changed) = send(
        &app,
        "POST",
        "/api/v1/auth/token/refresh",
        None,
        Some(json!({"refresh_token": renewed["refresh_token"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["privacy_consent_accepted"], false);
    sqlx::query("TRUNCATE terms_documents CASCADE")
        .execute(&owner)
        .await
        .unwrap();
    let (status, unpublished) = send(
        &app,
        "POST",
        "/api/v1/auth/token/refresh",
        None,
        Some(json!({"refresh_token": changed["refresh_token"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{unpublished}");
    assert_eq!(unpublished["privacy_consent_accepted"], false);
}

/// A failed consent snapshot rolls back rotation; it must never become an accepted or incomplete session.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn consent_snapshot_database_fault_fails_rotation(owner: PgPool) {
    let (app, _, user) = enrollment_session(&owner).await;
    let mut tx = owner.begin().await.unwrap();
    assert!(matches!(
        console_platform_request_context::privacy::family_accepted_in_tx(&mut tx, Uuid::nil())
            .await,
        Err(sqlx::Error::RowNotFound)
    ));
    tx.rollback().await.unwrap();
    let family = console_platform_auth::RefreshTokenStore
        .issue_family(
            &owner,
            user,
            OrgId::one(),
            OffsetDateTime::now_utc(),
            Duration::hours(1),
        )
        .await
        .unwrap();
    sqlx::query("ALTER TABLE terms_documents RENAME TO unavailable_documents")
        .execute(&owner)
        .await
        .unwrap();
    let (status, fault) = send(
        &app,
        "POST",
        "/api/v1/auth/token/refresh",
        None,
        Some(json!({"refresh_token": family.token.as_str()})),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{fault}");
    assert!(fault.get("access_token").is_none());
    sqlx::query("ALTER TABLE unavailable_documents RENAME TO terms_documents")
        .execute(&owner)
        .await
        .unwrap();
    let (status, recovered) = send(
        &app,
        "POST",
        "/api/v1/auth/token/refresh",
        None,
        Some(json!({"refresh_token": family.token.as_str()})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{recovered}");
    assert_eq!(recovered["privacy_consent_accepted"], false);
}
