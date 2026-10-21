//! Login ceremonies, including the server binding for identifier-first challenges.
use super::{
    AuthenticationCeremony, AuthenticationOutcome, PasskeyService, invalid_ceremony,
    lock_assertion_account_tx, lock_ceremony_tx, persist_ceremony,
};
use crate::AuthError;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;
use webauthn_rs::prelude::{PublicKeyCredential, RequestChallengeResponse};

impl PasskeyService {
    /// Start a usernameless (discoverable) authentication ceremony.
    ///
    /// The challenge carries an EMPTY `allowCredentials` list: the client
    /// discovers the resident credential to use without the server naming a user.
    /// The persisted ceremony has a NULL `user_id` because the asserting user is
    /// only known once the client returns the credential at finish time.
    pub async fn start_authentication(
        &self,
        pool: &PgPool,
    ) -> Result<AuthenticationCeremony, AuthError> {
        let (challenge, state) = self.webauthn.start_discoverable_authentication()?;
        let ceremony_id = Uuid::new_v4();
        let now = OffsetDateTime::now_utc();
        let expires_at = now + self.ceremony_ttl;

        persist_ceremony(
            pool,
            ceremony_id,
            None,
            "authentication",
            &challenge,
            &state,
            expires_at,
        )
        .await?;

        Ok(AuthenticationCeremony {
            ceremony_id,
            challenge,
            expires_at,
        })
    }

    /// Finish a usernameless (discoverable) authentication ceremony.
    ///
    /// The user is resolved FROM the asserted credential — by credential id,
    /// which is unique per credential and always present in the assertion — so no
    /// `user_id` is required from the client. When the authenticator returns a
    /// user handle (a true resident key), it is cross-checked against the
    /// resolved credential's owner. The atomic single-use ceremony claim from the
    /// harden-1 fix is preserved under a row lock, so a replayed ceremony is rejected.
    pub async fn finish_authentication(
        &self,
        pool: &PgPool,
        ceremony_id: Uuid,
        credential: PublicKeyCredential,
    ) -> Result<AuthenticationOutcome, AuthError> {
        let mut tx = pool.begin().await?;
        let outcome = self
            .finish_authentication_in_tx(&mut tx, ceremony_id, credential)
            .await?;
        tx.commit().await?;
        Ok(outcome)
    }

    /// Verify and consume a signed login proof in the caller's transaction.
    /// Session creation and its audit must commit with this proof, or all roll back.
    pub async fn finish_authentication_in_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        ceremony_id: Uuid,
        credential: PublicKeyCredential,
    ) -> Result<AuthenticationOutcome, AuthError> {
        let locator = lock_assertion_account_tx(tx, &credential).await?;
        let claim = lock_ceremony_tx(tx, ceremony_id, "authentication").await?;
        let challenge: RequestChallengeResponse =
            serde_json::from_value(claim.challenge_json.clone())?;
        // Synthetic allowlists must remain unusable even when the client replaces them.
        if claim.user_id.is_none() && !challenge.public_key.allow_credentials.is_empty() {
            return Err(invalid_ceremony());
        }
        self.verify_assertion_in_tx(tx, ceremony_id, claim, locator, credential, None)
            .await
    }
}
