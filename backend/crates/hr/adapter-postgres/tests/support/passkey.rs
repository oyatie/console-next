//! A real soft passkey for step-up tests: enroll a user, then sign a
//! step-up for one binding (moved from `sole_holder_step_up.rs`).

use console_kernel_core::OrgId;
use console_platform_auth::{
    MobilePasskeyStepUpAssertion, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope,
    PasskeyRegistrationStart,
};
use console_platform_test_support::soft_passkey::passkey_service;
use serde_json::json;
use sqlx::PgPool;
use url::Url;
use uuid::Uuid;
use webauthn_authenticator_rs::{WebauthnAuthenticator, softpasskey::SoftPasskey};

use super::World;

pub fn origin() -> Url {
    Url::parse("https://auth.example.com").unwrap()
}

pub struct Key {
    pub user: Uuid,
    pub credential_id: String,
    pub authenticator: WebauthnAuthenticator<SoftPasskey>,
}

pub async fn enroll(pool: &PgPool, w: &World, user: Uuid) -> Key {
    let service = passkey_service();
    let org = OrgId::from_uuid(w.org);
    let start = service
        .start_registration(
            pool,
            org,
            PasskeyRegistrationStart {
                user_id: user,
                username: user.to_string(),
                display_name: "HR".into(),
            },
        )
        .await
        .unwrap();
    let mut challenge = start.challenge;
    if let Some(selection) = challenge.public_key.authenticator_selection.as_mut() {
        selection.require_resident_key = false;
    }
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let credential = authenticator.do_registration(origin(), challenge).unwrap();
    let stored = service
        .finish_registration(pool, org, start.ceremony_id, credential)
        .await
        .unwrap();
    Key {
        user,
        credential_id: stored.credential_id,
        authenticator,
    }
}

pub async fn step_up(
    pool: &PgPool,
    key: &mut Key,
    binding: MobilePasskeyStepUpBinding,
) -> MobilePasskeyStepUpEnvelope {
    let start = passkey_service()
        .start_mobile_step_up(pool, key.user, binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{ "type": "public-key", "id": key.credential_id }]);
    let credential = key
        .authenticator
        .do_authentication(origin(), serde_json::from_value(challenge).unwrap())
        .unwrap();
    MobilePasskeyStepUpEnvelope {
        binding,
        assertion: MobilePasskeyStepUpAssertion {
            ceremony_id: start.ceremony_id,
            credential,
        },
    }
}
