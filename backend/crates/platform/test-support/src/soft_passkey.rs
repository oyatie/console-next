//! Software passkeys for tests (see the module doc in `lib.rs`).

use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{PasskeyRegistrationStart, PasskeyService, WebauthnSettings};
use serde_json::{Value, json};
use sqlx::PgPool;
use url::Url;
use webauthn_authenticator_rs::prelude::{RequestChallengeResponse, WebauthnAuthenticator};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;

const RP_ID: &str = "example.com";
const ORIGIN: &str = "https://auth.example.com";

/// The passkey service (RP `example.com`) the soft keys assert against.
#[must_use]
pub fn passkey_service() -> PasskeyService {
    PasskeyService::new(WebauthnSettings {
        rp_id: RP_ID.to_owned(),
        rp_origin: Url::parse(ORIGIN).unwrap(),
        rp_name: "Console".to_owned(),
        extra_allowed_origins: vec![],
        ceremony_ttl: time::Duration::minutes(5),
    })
    .unwrap()
}

pub struct SoftKey {
    authenticator: WebauthnAuthenticator<SoftPasskey>,
    credential_id: String,
}

impl SoftKey {
    /// Enroll a fresh soft passkey for `user` in `org` (owner pool).
    pub async fn enroll(pool: &PgPool, org: OrgId, user: UserId) -> Self {
        let service = passkey_service();
        let registration = service
            .start_registration(
                pool,
                org,
                PasskeyRegistrationStart {
                    user_id: *user.as_uuid(),
                    username: format!("user-{}", user.as_uuid()),
                    display_name: "Test User".to_owned(),
                },
            )
            .await
            .unwrap();
        let mut challenge = registration.challenge;
        if let Some(selection) = challenge.public_key.authenticator_selection.as_mut() {
            selection.require_resident_key = false;
        }
        let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
        let credential = authenticator
            .do_registration(Url::parse(ORIGIN).unwrap(), challenge)
            .unwrap();
        let stored = service
            .finish_registration(pool, org, registration.ceremony_id, credential)
            .await
            .unwrap();
        Self {
            authenticator,
            credential_id: stored.credential_id,
        }
    }

    /// The credential id this key holds (base64url).
    #[must_use]
    pub fn credential_id(&self) -> &str {
        &self.credential_id
    }

    /// Assert against a server challenge exactly as served (`{ publicKey }`).
    /// A soft key is non-resident: it answers only a list that names it.
    pub fn assert(&mut self, challenge: &Value) -> Result<Value, String> {
        let challenge: RequestChallengeResponse =
            serde_json::from_value(challenge.clone()).map_err(|e| e.to_string())?;
        self.authenticator
            .do_authentication(Url::parse(ORIGIN).unwrap(), challenge)
            .map(|credential| serde_json::to_value(credential).unwrap())
            .map_err(|e| format!("{e:?}"))
    }

    /// A fresh `{ ceremony_id, credential }` step-up assertion.
    pub async fn step_up(&mut self, pool: &PgPool) -> Value {
        let ceremony = passkey_service().start_authentication(pool).await.unwrap();
        let mut challenge = serde_json::to_value(&ceremony.challenge).unwrap();
        // SoftPasskey has no resident-key store: name the credential it holds.
        challenge["publicKey"]["allowCredentials"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "type": "public-key", "id": self.credential_id }));
        let challenge: RequestChallengeResponse = serde_json::from_value(challenge).unwrap();
        let credential = self
            .authenticator
            .do_authentication(Url::parse(ORIGIN).unwrap(), challenge)
            .unwrap();
        json!({ "ceremony_id": ceremony.ceremony_id, "credential": credential })
    }
}
