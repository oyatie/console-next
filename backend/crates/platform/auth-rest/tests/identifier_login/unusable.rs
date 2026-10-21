//! A modified client cannot turn an unusable identifier into usernameless sign-in.
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unusable_identifiers_refuse_an_owned_key_even_when_the_client_changes_the_allowlist(
    owner: PgPool,
) {
    let (user, old_id) = account(&owner, "도메인 변경").await;
    let mut key = SoftKey::enroll(&owner, OrgId::one(), user).await;
    sqlx::query("SELECT platform_rename_organization($1, 'current-company', NULL, now() - interval '100 days', now() - interval '10 days')")
        .bind(*OrgId::one().as_uuid()).execute(&owner).await.unwrap();
    let before: (i64, i64, Value) = sqlx::query_as("SELECT (SELECT count(*) FROM auth_refresh_token_families), (SELECT count(*) FROM audit_events), passkey_json FROM auth_webauthn_credentials WHERE user_id=$1")
        .bind(*user.as_uuid()).fetch_one(&owner).await.unwrap();
    let app = router(state(runtime_role_pool(&owner).await));
    for identifier in ["unknown@unknown-company".to_owned(), old_id] {
        let (status, started) = start(&app, Some(&identifier)).await;
        assert_eq!(status, StatusCode::OK, "{started}");
        let mut challenge = started["challenge"].clone();
        challenge["publicKey"]["allowCredentials"] =
            json!([{ "type": "public-key", "id": key.credential_id() }]);
        let credential = key.assert(&challenge).unwrap();
        let (status, refused) = finish(&app, &started, credential).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{identifier}: {refused}");
        assert_eq!(refused["error"]["code"], "unauthorized");
        let consumed: Option<time::OffsetDateTime> = sqlx::query_scalar(
            "SELECT consumed_at FROM auth_webauthn_ceremonies WHERE id=$1::uuid",
        )
        .bind(started["ceremony_id"].as_str().unwrap())
        .fetch_one(&owner)
        .await
        .unwrap();
        assert!(consumed.is_none());
        let after: (i64, i64, Value) = sqlx::query_as("SELECT (SELECT count(*) FROM auth_refresh_token_families), (SELECT count(*) FROM audit_events), passkey_json FROM auth_webauthn_credentials WHERE user_id=$1")
            .bind(*user.as_uuid()).fetch_one(&owner).await.unwrap();
        assert_eq!(before, after, "a refused proof writes nothing");
    }
    // A real usernameless ceremony still accepts the same credential.
    let (_, open) = start(&app, None).await;
    let mut challenge = open["challenge"].clone();
    challenge["publicKey"]["allowCredentials"] =
        json!([{ "type": "public-key", "id": key.credential_id() }]);
    let (status, tokens) = finish(&app, &open, key.assert(&challenge).unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{tokens}");
}
