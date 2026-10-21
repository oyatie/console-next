//! Identifier-first and step-up ceremonies (decisions #33): a discoverable
//! state whose `allowCredentials` names one account's credentials (or one
//! synthetic id), so non-resident keys sign in and confirm, and registration
//! only prefers a resident key.

use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;
use webauthn_rs::prelude::CreationChallengeResponse;
use webauthn_rs_proto::{AllowCredentials, ResidentKeyRequirement};

use super::{AuthenticationCeremony, PasskeyService, persist_ceremony};
use crate::AuthError;
use console_kernel_core::OrgId;

impl PasskeyService {
    /// Start an identifier-first ceremony (decisions #33): `identifier` is a
    /// normalised `<아이디>@<domain>`. The challenge's `allowCredentials` names
    /// the account's credentials, so a non-resident key signs in too. Anything
    /// unusable (unknown 아이디 or domain, no passkey, deactivated account,
    /// expired alias) gets one synthetic id from `platform_sign_in_options`,
    /// stable per identifier: the response never tells the cases apart.
    pub async fn start_identified_authentication(
        &self,
        pool: &PgPool,
        identifier: &str,
    ) -> Result<AuthenticationCeremony, AuthError> {
        let (user_id, credential_ids): (Option<Uuid>, Vec<String>) =
            sqlx::query_as("SELECT user_id, credential_ids FROM platform_sign_in_options($1)")
                .bind(identifier)
                // rls-arming: ok platform_sign_in_options is the narrow SECURITY DEFINER pre-auth resolver (0350)
                .fetch_one(pool)
                .await?;
        self.start_bound_authentication(pool, user_id, &credential_ids)
            .await
    }

    /// Start a step-up ceremony for the signed-in `user_id`: `allowCredentials`
    /// names only the caller's own credentials, so a caller whose one key is
    /// non-resident can still confirm a governed action.
    pub async fn start_own_authentication(
        &self,
        pool: &PgPool,
        org: OrgId,
        user_id: Uuid,
    ) -> Result<AuthenticationCeremony, AuthError> {
        let credential_ids = own_credential_ids(pool, org, user_id).await?;
        self.start_bound_authentication(pool, Some(user_id), &credential_ids)
            .await
    }

    /// Name the caller's own credentials in a bound step-up challenge (the
    /// action-bound `step-up/start` route), for the same non-resident reason.
    /// Only the served challenge changes: the verifier resolves the credential.
    pub async fn name_own_credentials(
        pool: &PgPool,
        org: OrgId,
        user_id: Uuid,
        ceremony: &mut AuthenticationCeremony,
    ) -> Result<(), AuthError> {
        let ids = own_credential_ids(pool, org, user_id).await?;
        ceremony.challenge.public_key.allow_credentials = allow_list(&ids)?;
        Ok(())
    }

    /// A discoverable ceremony whose `allowCredentials` lists `credential_ids`
    /// (no transports, so real and synthetic entries look alike), bound to
    /// `user_id` when known: finish then refuses any other account's credential.
    async fn start_bound_authentication(
        &self,
        pool: &PgPool,
        user_id: Option<Uuid>,
        credential_ids: &[String],
    ) -> Result<AuthenticationCeremony, AuthError> {
        let (mut challenge, state) = self.webauthn.start_discoverable_authentication()?;
        challenge.mediation = None;
        challenge.public_key.allow_credentials = allow_list(credential_ids)?;
        let ceremony_id = Uuid::new_v4();
        let expires_at = OffsetDateTime::now_utc() + self.ceremony_ttl;
        persist_ceremony(
            pool,
            ceremony_id,
            user_id,
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
}

/// The caller's credential ids, oldest first (FORCE RLS: the GUC is armed).
async fn own_credential_ids(
    pool: &PgPool,
    org: OrgId,
    user_id: Uuid,
) -> Result<Vec<String>, AuthError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await?;
    let ids = sqlx::query_scalar(
        "SELECT credential_id FROM auth_webauthn_credentials \
          WHERE org_id = $1 AND user_id = $2 ORDER BY created_at, id",
    )
    .bind(*org.as_uuid())
    .bind(user_id)
    .fetch_all(tx.as_mut())
    .await?;
    tx.commit().await?;
    Ok(ids)
}

/// `allowCredentials` entries with no transports, so real and synthetic ids
/// look alike.
fn allow_list(ids: &[String]) -> Result<Vec<AllowCredentials>, AuthError> {
    ids.iter()
        .map(|id| {
            Ok(AllowCredentials {
                type_: "public-key".to_owned(),
                id: serde_json::from_value(serde_json::Value::String(id.clone()))?,
                transports: None,
            })
        })
        .collect()
}

/// `start_passkey_registration` emits `residentKey: "discouraged"`. Ask for
/// `"preferred"` (decisions #33): an authenticator with room keeps a
/// discoverable credential (autofill and the usernameless button sign in with
/// it), and a security key with no free resident slot still enrols, then signs
/// in identifier-first (`allowCredentials` names it). The stored registration
/// state ignores this flag at finish, so attestation verification is unchanged.
pub(super) fn prefer_discoverable_credential(challenge: &mut CreationChallengeResponse) {
    if let Some(selection) = challenge.public_key.authenticator_selection.as_mut() {
        selection.resident_key = Some(ResidentKeyRequirement::Preferred);
        selection.require_resident_key = false;
    }
}
