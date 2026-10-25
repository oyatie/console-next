//! The rest of `identifier_login`: account binding, alias, step-up, typed
//! refusals, the resident-key preference and the platform tier. A child module
//! (its harness), kept apart so each file stays under the size ceiling.

use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_ceremony_for_one_account_refuses_another_accounts_key(owner: PgPool) {
    let (a, a_id) = account(&owner, "가").await;
    SoftKey::enroll(&owner, OrgId::one(), a).await;
    let (b, _) = account(&owner, "나").await;
    let mut b_key = SoftKey::enroll(&owner, OrgId::one(), b).await;
    let app = router(state(runtime_role_pool(&owner).await));

    let (_, started) = start(&app, Some(&a_id)).await;
    let mut challenge = started["challenge"].clone();
    challenge["publicKey"]["allowCredentials"] =
        json!([{ "type": "public-key", "id": b_key.credential_id() }]);
    let credential = b_key.assert(&challenge).unwrap();
    let (status, refused) = finish(&app, &started, credential).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{refused}");
    let consumed: Option<time::OffsetDateTime> =
        sqlx::query_scalar("SELECT consumed_at FROM auth_webauthn_ceremonies WHERE id = $1::uuid")
            .bind(started["ceremony_id"].as_str().unwrap())
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(consumed.is_none(), "a refused proof consumes nothing");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_alias_signs_in_within_its_grace_period(owner: PgPool) {
    let (user, current) = account(&owner, "개명").await;
    let mut key = SoftKey::enroll(&owner, OrgId::one(), user).await;
    sqlx::query(
        "INSERT INTO user_sign_in_ids (org_id, login, user_id, effective_date, reason_code, retired_at, alias_until) \
         VALUES ($1, 'old.name', $2, current_date, 'NAME_CHANGE', now(), now() + interval '90 days')",
    )
    .bind(*OrgId::one().as_uuid())
    .bind(*user.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    let domain = current.split_once('@').unwrap().1;
    let app = router(state(runtime_role_pool(&owner).await));

    let (status, started) = start(&app, Some(&format!("old.name@{domain}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(allowed(&started), vec![key.credential_id().to_owned()]);
    let (status, _) = finish(&app, &started, key.assert(&started["challenge"]).unwrap()).await;
    assert_eq!(status, StatusCode::OK, "the alias signs in");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_step_up_names_only_the_callers_own_keys(owner: PgPool) {
    console_platform_test_support::seed_consent_documents(&owner).await;
    let (a, a_id) = account(&owner, "가").await;
    let mut a_key = SoftKey::enroll(&owner, OrgId::one(), a).await;
    let (b, _) = account(&owner, "나").await;
    SoftKey::enroll(&owner, OrgId::one(), b).await;
    let app = router(state(runtime_role_pool(&owner).await));

    let (_, started) = start(&app, Some(&a_id)).await;
    let (_, tokens) = finish(&app, &started, a_key.assert(&started["challenge"]).unwrap()).await;
    let token = tokens["access_token"].as_str().unwrap();
    let (status, step_up) = post(&app, PASSKEY_LOGIN_START_PATH, Some(token), None).await;
    assert_eq!(status, StatusCode::OK, "{step_up}");
    assert_eq!(allowed(&step_up), vec![a_key.credential_id().to_owned()]);
    // The action-bound step-up names the caller's keys too.
    let binding = json!({
        "action_kind": "PERIOD_UNLOCK", "object_id": Uuid::new_v4(),
        "reason_key": "passkey_step_up_period_unlock", "replay_attempt": null,
        "payload_hash": "0".repeat(64),
    });
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_webauthn_ceremonies")
        .fetch_one(&owner)
        .await
        .unwrap();
    let (status, refused) = post(
        &app,
        PASSKEY_STEP_UP_START_PATH,
        Some(token),
        Some(json!({ "binding": binding.clone() })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["error"]["code"], "privacy_consent_required");
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_webauthn_ceremonies")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(after, before, "refused step-up must create no ceremony");
    let (status, consent) = post(
        &app,
        console_platform_auth_rest::PRIVACY_CONSENT_STATUS_PATH,
        Some(token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{consent}");
    let (status, accepted) = post(
        &app,
        console_platform_auth_rest::PRIVACY_CONSENT_ACCEPT_PATH,
        Some(token),
        Some(
            json!({ "privacy": consent["privacy"], "terms": consent["terms"],
            "privacy_collection": true, "terms_of_service": true }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    let (status, bound) = post(
        &app,
        PASSKEY_STEP_UP_START_PATH,
        Some(token),
        Some(json!({ "binding": binding })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{bound}");
    assert_eq!(allowed(&bound), vec![a_key.credential_id().to_owned()]);
    // A token that does not verify falls back to usernameless.
    let (status, fallback) = post(&app, PASSKEY_LOGIN_START_PATH, Some("not-a-token"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(allowed(&fallback).is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refusals_are_typed_and_write_nothing(owner: PgPool) {
    let (_, sign_in_id) = account(&owner, "가").await;
    let app = router(state(runtime_role_pool(&owner).await));
    let ceremonies = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM auth_webauthn_ceremonies")
            .fetch_one(&owner)
            .await
            .unwrap()
    };
    let before = ceremonies().await;
    for bad in [
        "hong",
        "홍길동@acme",
        "ho..ng@acme",
        "hong@",
        "@acme",
        "hong@a",
    ] {
        let (status, refused) = start(&app, Some(bad)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {refused}");
        assert_eq!(refused["error"]["code"], "sign_in_id_invalid", "{bad}");
    }
    assert_eq!(
        ceremonies().await,
        before,
        "a refused start persists nothing"
    );

    // 20 starts per identifier a minute, counted the same for unknown ones.
    for identifier in [sign_in_id.clone(), "nobody@no-such-company".to_owned()] {
        for _ in 0..20 {
            assert_eq!(start(&app, Some(&identifier)).await.0, StatusCode::OK);
        }
        let (status, limited) = start(&app, Some(&identifier)).await;
        assert_eq!(
            status,
            StatusCode::TOO_MANY_REQUESTS,
            "{identifier}: {limited}"
        );
        assert_eq!(limited["error"]["code"], "too_many_requests");
    }
    assert_eq!(
        start(&app, Some("someone.else@no-such-company")).await.0,
        StatusCode::OK
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_prefers_a_resident_key(owner: PgPool) {
    let (user, _) = account(&owner, "등록").await;
    let ceremony = passkey_service()
        .start_registration(
            &owner,
            OrgId::one(),
            console_platform_auth::PasskeyRegistrationStart {
                user_id: *user.as_uuid(),
                username: "hong@sae".to_owned(),
                display_name: "등록".to_owned(),
            },
        )
        .await
        .unwrap();
    let selection =
        serde_json::to_value(&ceremony.challenge).unwrap()["publicKey"]["authenticatorSelection"]
            .clone();
    assert_eq!(selection["residentKey"], "preferred");
    assert_eq!(selection["requireResidentKey"], false);
}

/// regression (E2E 2026-10-09): the vendor tier's own organizations row is
/// ARCHIVED; its admin still signs in by ID right after enrolling.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_platform_tier_signs_in_by_id(owner: PgPool) {
    let platform = OrgId::from_uuid(Uuid::from_u128(0xface));
    sqlx::query("DELETE FROM users WHERE org_id=$1 AND roles @> ARRAY['SUPER_ADMIN']::text[]")
        .bind(platform.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    let id: Uuid = sqlx::query_scalar("SELECT platform_ensure_cold_start_admin()")
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut key = SoftKey::enroll(&owner, platform, UserId::from_uuid(id)).await;
    let login: String = sqlx::query_scalar("SELECT login FROM user_sign_in_ids WHERE user_id = $1")
        .bind(id)
        .fetch_one(&owner)
        .await
        .unwrap();
    let app = router(state(runtime_role_pool(&owner).await));
    let (status, started) = start(&app, Some(&format!("{login}@platform"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(allowed(&started), vec![key.credential_id().to_owned()]);
    let (status, tokens) = finish(&app, &started, key.assert(&started["challenge"]).unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{tokens}");
    assert_eq!(
        tokens["passkey_profile"]["name"],
        format!("{login}@platform")
    );
    assert_eq!(
        tokens["passkey_profile"]["display_name"],
        tokens["passkey_profile"]["name"]
    );
}

/// A SUSPENDED or ARCHIVED customer tenant gets no session (security review of
/// the resolver filter): its ID answers `login/start` like any unusable ID, a
/// usernameless proof is refused at finish with `tenant_inactive` and nothing
/// is written, and a live session's refresh is refused the same way.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_inactive_tenant_gets_no_session_on_any_path(owner: PgPool) {
    let (user, sign_in_id) = account(&owner, "정지").await;
    let mut key = SoftKey::enroll(&owner, OrgId::one(), user).await;
    let (_, reference_id) = account(&owner, "대조").await;
    let app = router(state(runtime_role_pool(&owner).await));

    // While ACTIVE: a session with a body refresh token.
    let (_, started) = start(&app, Some(&sign_in_id)).await;
    let (status, tokens) = finish(&app, &started, key.assert(&started["challenge"]).unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{tokens}");
    let refresh = tokens["refresh_token"].as_str().unwrap().to_owned();

    for tenant_status in ["SUSPENDED", "ARCHIVED"] {
        sqlx::query("UPDATE organizations SET status = $1 WHERE id = $2")
            .bind(tenant_status)
            .bind(*OrgId::one().as_uuid())
            .execute(&owner)
            .await
            .unwrap();
        // Identifier first: the same shape as an unusable ID (a synthetic id,
        // not the key), so `login/start` reveals nothing.
        let (status, by_id) = start(&app, Some(&sign_in_id)).await;
        let (_, unusable) = start(&app, Some(&reference_id)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(shape(&by_id), shape(&unusable), "{tenant_status}");
        assert_ne!(
            allowed(&by_id),
            vec![key.credential_id().to_owned()],
            "{tenant_status}"
        );

        // Usernameless: the proof verifies, the session is refused, typed.
        let families = || async {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM auth_refresh_token_families")
                .fetch_one(&owner)
                .await
                .unwrap()
        };
        let before = families().await;
        let (_, open) = start(&app, None).await;
        let mut challenge = open["challenge"].clone();
        challenge["publicKey"]["allowCredentials"] =
            json!([{ "type": "public-key", "id": key.credential_id() }]);
        let (status, refused) = finish(&app, &open, key.assert(&challenge).unwrap()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{tenant_status}: {refused}");
        assert_eq!(refused["error"]["code"], "tenant_inactive");
        assert_eq!(
            families().await,
            before,
            "{tenant_status}: no session family"
        );
        let consumed: Option<time::OffsetDateTime> = sqlx::query_scalar(
            "SELECT consumed_at FROM auth_webauthn_ceremonies WHERE id = $1::uuid",
        )
        .bind(open["ceremony_id"].as_str().unwrap())
        .fetch_one(&owner)
        .await
        .unwrap();
        assert!(
            consumed.is_none(),
            "{tenant_status}: the refused finish rolls back"
        );

        // A live session cannot be refreshed either.
        let (status, refused) = post(
            &app,
            TOKEN_REFRESH_PATH,
            None,
            Some(json!({ "refresh_token": refresh })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{tenant_status}: {refused}");
        assert_eq!(refused["error"]["code"], "tenant_inactive");
    }
}
