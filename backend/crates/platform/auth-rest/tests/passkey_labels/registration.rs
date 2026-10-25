// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_labels_are_validated_before_step_up_and_credential_creation(owner: PgPool) {
    let mut f = Fixture::new(owner).await;
    let (status, policy) = request(
        &f.app,
        "GET",
        "/api/v1/auth/passkeys/policy",
        Some(&f.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{policy}");
    let max = policy["label_max_length"].as_u64().unwrap() as usize;
    let proof = f.soft.step_up(&f.owner).await;
    let before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_webauthn_ceremonies WHERE ceremony_kind='registration'",
    )
    .fetch_one(&f.owner)
    .await
    .unwrap();
    for invalid in ["가".repeat(max + 1), "줄\n바꿈".into(), " ".into()] {
        let (status, refused) = request(
            &f.app,
            "POST",
            "/api/v1/auth/passkey/register/start",
            Some(&f.token),
            json!({"label":invalid,"step_up":proof}),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
        assert_eq!(refused["error"]["code"], "passkey_label_invalid");
        let after: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM auth_webauthn_ceremonies WHERE ceremony_kind='registration'",
        )
        .fetch_one(&f.owner)
        .await
        .unwrap();
        assert_eq!(after, before);
    }
    // A rejected name must not burn the existing key's step-up assertion either.
    let (status, started) = request(
        &f.app,
        "POST",
        "/api/v1/auth/passkey/register/start",
        Some(&f.token),
        json!({"label":"가".repeat(max),"step_up":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_persists_its_label_and_audit_and_invalid_finish_consumes_nothing(
    owner: PgPool,
) {
    use webauthn_authenticator_rs::{WebauthnAuthenticator, softpasskey::SoftPasskey};
    let mut f = Fixture::new(owner).await;
    let proof = f.soft.step_up(&f.owner).await;
    let (status, started) = request(
        &f.app,
        "POST",
        "/api/v1/auth/passkey/register/start",
        Some(&f.token),
        json!({"label":"개인 보안키","step_up":proof}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let mut challenge = started["challenge"].clone();
    // The software authenticator has no resident-key store; the server challenge stays unchanged.
    challenge["publicKey"]["authenticatorSelection"]["requireResidentKey"] = json!(false);
    let mut device = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = device
        .do_registration(
            "https://auth.example.com".parse().unwrap(),
            serde_json::from_value(challenge).unwrap(),
        )
        .unwrap();
    let before = f.state(f.key).await;
    let (status, refused) = request(
        &f.app,
        "POST",
        "/api/v1/auth/passkey/register/finish",
        Some(&f.token),
        json!({"ceremony_id":started["ceremony_id"],"credential":credential,"label":"제어\n문자"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{refused}");
    assert_eq!(refused["error"]["code"], "passkey_label_invalid");
    assert_eq!(f.state(f.key).await, before);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_webauthn_credentials")
        .fetch_one(&f.owner)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let consumed: bool = sqlx::query_scalar(
        "SELECT consumed_at IS NOT NULL FROM auth_webauthn_ceremonies WHERE id=$1",
    )
    .bind(
        started["ceremony_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap(),
    )
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert!(!consumed);
    let (status, finished) = request(&f.app, "POST", "/api/v1/auth/passkey/register/finish", Some(&f.token), json!({"ceremony_id":started["ceremony_id"],"credential":credential,"label":"  개인 보안키  "})).await;
    assert_eq!(status, StatusCode::CREATED, "{finished}");
    let id = finished["passkey_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let (stored, audits) = f.state(id).await;
    assert_eq!(stored["label"], "개인 보안키");
    assert_eq!(audits, before.1 + 1);
    let audit: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE action='auth.passkey.rename' AND target_id=$1",
    )
    .bind(id.to_string())
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(audit["label"], "개인 보안키");
    let (_, listed) = request(
        &f.app,
        "GET",
        "/api/v1/auth/passkeys",
        Some(&f.token),
        Value::Null,
    )
    .await;
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|key| key["id"] == finished["passkey_id"] && key["label"] == "개인 보안키")
    );
}
