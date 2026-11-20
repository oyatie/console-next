// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::{
    Router,
    body::{Body, to_bytes},
};
use console_app::{AppConfig, AppRole, AppState, DatabaseDependency, build_router};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use http::{Request, StatusCode, header};
use p256::{
    ecdsa::SigningKey,
    elliptic_curve::Generate,
    pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;
use webauthn_authenticator_rs::prelude::{
    CreationChallengeResponse, RequestChallengeResponse, WebauthnAuthenticator,
};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

pub const ORIGIN: &str = "https://auth.example.com";

pub fn build_app_router(pool: PgPool) -> Router {
    let key = SigningKey::generate();
    let pairs = vec![
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ("CONSOLE_JWT_ISSUER", "console-test".to_owned()),
        ("CONSOLE_JWT_AUDIENCE", "console".to_owned()),
        (
            "CONSOLE_JWT_PRIVATE_KEY_PEM",
            key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        ),
        (
            "CONSOLE_JWT_PUBLIC_KEY_PEM",
            key.verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
        ),
        ("CONSOLE_WEBAUTHN_RP_ID", "example.com".to_owned()),
        ("CONSOLE_WEBAUTHN_RP_ORIGIN", ORIGIN.to_owned()),
    ];
    build_router(
        AppState::new(
            AppConfig::from_pairs(pairs).unwrap(),
            DatabaseDependency::Postgres(pool),
        )
        .unwrap(),
    )
}

pub async fn req(
    service: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    idempotency_key: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(key) = idempotency_key {
        builder = builder.header("Idempotency-Key", key);
    }
    let request = match body {
        Some(json_body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json_body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = service.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

pub struct EnrolledSession {
    pub access_token: String,
    pub refresh_token: String,
    pub sign_in_id: String,
    pub authenticator: WebauthnAuthenticator<SoftPasskey>,
    pub credential_id: String,
}

pub async fn complete_otp_passkey_enrolment(
    service: &Router,
    otp_or_invite: &str,
) -> EnrolledSession {
    let (status, redeemed) = req(
        service,
        "POST",
        "/api/v1/auth/otp/redeem",
        None,
        None,
        Some(json!({ "otp": otp_or_invite })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "redeem failed: {redeemed}");
    let enroll_token = redeemed["access_token"].as_str().unwrap().to_owned();

    // Enrollment-only token is blocked from /api/platform/*.
    let (blocked_status, blocked_body) = req(
        service,
        "GET",
        "/api/platform/operators",
        Some(&enroll_token),
        None,
        None,
    )
    .await;
    assert_eq!(blocked_status, StatusCode::FORBIDDEN, "{blocked_body}");
    assert_eq!(blocked_body["error"]["code"], "passkey_required");

    // Accept privacy consent.
    let (status, docs) = req(
        service,
        "POST",
        "/api/v1/auth/privacy-consent/status",
        Some(&enroll_token),
        None,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{docs}");
    let (status, consent) = req(
        service,
        "POST",
        "/api/v1/auth/privacy-consent/accept",
        Some(&enroll_token),
        None,
        Some(json!({
            "privacy": docs["privacy"],
            "terms": docs["terms"],
            "privacy_collection": true,
            "terms_of_service": true,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{consent}");

    // Register passkey.
    let (status, reg_start) = req(
        service,
        "POST",
        "/api/v1/auth/passkey/register/start",
        Some(&enroll_token),
        None,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reg_start}");
    let mut challenge_val = reg_start["challenge"].clone();
    challenge_val["publicKey"]["authenticatorSelection"]["requireResidentKey"] = json!(false);
    let challenge: CreationChallengeResponse = serde_json::from_value(challenge_val).unwrap();
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let reg_cred = authenticator
        .do_registration(Url::parse(ORIGIN).unwrap(), challenge)
        .unwrap();
    let (status, reg_finish) = req(
        service,
        "POST",
        "/api/v1/auth/passkey/register/finish",
        Some(&enroll_token),
        None,
        Some(json!({
            "ceremony_id": reg_start["ceremony_id"],
            "credential": reg_cred,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{reg_finish}");
    let credential_id = reg_finish["credential_id"].as_str().unwrap().to_owned();
    let sign_in_id = reg_finish["sign_in_id"].as_str().unwrap().to_owned();

    // Passkey login to obtain a full non-enrollment platform session.
    let (status, login_start) = req(
        service,
        "POST",
        "/api/v1/auth/passkey/login/start",
        None,
        None,
        Some(json!({ "identifier": sign_in_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login_start}");
    let login_challenge: RequestChallengeResponse =
        serde_json::from_value(login_start["challenge"].clone()).unwrap();
    let auth_cred = authenticator
        .do_authentication(Url::parse(ORIGIN).unwrap(), login_challenge)
        .unwrap();
    let (status, session) = req(
        service,
        "POST",
        "/api/v1/auth/passkey/login/finish",
        None,
        None,
        Some(json!({
            "ceremony_id": login_start["ceremony_id"],
            "credential": auth_cred,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");

    EnrolledSession {
        access_token: session["access_token"].as_str().unwrap().to_owned(),
        refresh_token: session["refresh_token"].as_str().unwrap().to_owned(),
        sign_in_id,
        authenticator,
        credential_id,
    }
}

pub async fn bound_step_up(
    service: &Router,
    session: &mut EnrolledSession,
    object_id: Uuid,
    payload_hash: String,
) -> Value {
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::OperatorRecovery,
        object_id,
        payload_hash,
    );
    let (status, start) = req(
        service,
        "POST",
        "/api/v1/auth/passkey/step-up/start",
        Some(&session.access_token),
        None,
        Some(json!({ "binding": binding })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "step-up start failed: {start}");
    let mut challenge_val = start["challenge"].clone();
    challenge_val["publicKey"]["allowCredentials"] =
        json!([{"type": "public-key", "id": session.credential_id}]);
    let challenge: RequestChallengeResponse = serde_json::from_value(challenge_val).unwrap();
    let credential = session
        .authenticator
        .do_authentication(Url::parse(ORIGIN).unwrap(), challenge)
        .unwrap();
    json!({
        "binding": binding,
        "assertion": {
            "ceremony_id": start["ceremony_id"],
            "credential": credential,
        }
    })
}
