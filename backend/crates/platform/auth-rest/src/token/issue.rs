use crate::context::load::UserAuthContext;
use crate::dto::token::TokenPairResponse;
use crate::error::RestError;
use crate::state::AuthServices;
use console_kernel_core::OrgId;
use console_platform_auth::AccessTokenInput;
#[cfg(feature = "dev-auth")]
use console_platform_db::DbError;
use console_platform_db::insert_audit_event;
#[cfg(feature = "dev-auth")]
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug)]
pub(crate) struct IssuedTokenPair {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) refresh_expires_at: OffsetDateTime,
    pub(crate) family_id: Uuid,
}

impl IssuedTokenPair {
    /// Body-transport (mobile) response: the refresh token rides in the JSON body.
    pub(crate) fn into_response(self) -> TokenPairResponse {
        TokenPairResponse {
            access_token: self.access_token,
            refresh_token: Some(self.refresh_token),
            token_type: "Bearer",
            refresh_expires_at: self.refresh_expires_at,
            requires_passkey_setup: false,
            passkey_profile: None,
        }
    }
}

#[cfg(feature = "dev-auth")]
pub(crate) async fn issue_token_pair(
    pool: &PgPool,
    services: &AuthServices,
    user: &UserAuthContext,
) -> Result<IssuedTokenPair, RestError> {
    let mut tx = pool.begin().await.map_err(DbError::Sqlx)?;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(user.org_id.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .map_err(DbError::Sqlx)?;
    let tokens = issue_token_pair_in_tx(&mut tx, services, user, false).await?;
    tx.commit().await.map_err(DbError::Sqlx)?;
    Ok(tokens)
}

pub(crate) async fn issue_token_pair_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    services: &AuthServices,
    user: &UserAuthContext,
    enrollment: bool,
) -> Result<IssuedTokenPair, RestError> {
    let (refresh, audit) = services
        .refresh_tokens
        .issue_family_in_tx(
            tx,
            *user.user_id.as_uuid(),
            user.org_id,
            OffsetDateTime::now_utc(),
            services.refresh_token_ttl,
        )
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    let access_token = issue_access_token(services, user, &refresh, enrollment)?;
    insert_audit_event(tx, &audit).await?;
    Ok(IssuedTokenPair {
        access_token,
        refresh_token: refresh.token.as_str().to_owned(),
        refresh_expires_at: refresh.expires_at,
        family_id: refresh.family_id,
    })
}

/// Mint a fresh access JWT for `user`. Shared by the refresh path, which pairs it
/// with either a rotated cookie (web) or a body refresh token (mobile).
pub(crate) fn issue_access_token(
    services: &AuthServices,
    user: &UserAuthContext,
    refresh: &console_platform_auth::RefreshTokenIssue,
    enrollment: bool,
) -> Result<String, RestError> {
    let input = AccessTokenInput {
        subject: user.user_id,
        org_id: user.org_id,
        roles: user.roles.clone(),
        branches: user.branches.clone(),
        // A user homed in the platform sentinel org is the PLATFORM admin:
        // mint a platform token so it can reach `/api/platform/*` (and is rejected
        // on tenant `/api/*`). Every real tenant user gets `false`.
        platform: user.org_id == OrgId::platform(),
        // The ordinary refresh path never mints an impersonation token.
        view_as: false,
        read_only: false,
        // DISPLAY-ONLY identity for the topbar; re-loaded from the user on
        // every refresh so a renamed user's token reflects it. Never authz.
        display_name: Some(user.display_name.clone()),
        feature_grants: user.feature_grants.clone(),
        // Subject authorization freshness snapshot (Cedar/PBAC, ADR-0021),
        // re-resolved from the DB on every refresh so a rotated token carries the
        // current values for request-boundary validation.
        authz_subject_version: user.authz_subject_version,
        authz_policy_version: user.authz_policy_version,
        session_generation: user.session_generation,
        issued_at: OffsetDateTime::now_utc(),
    };
    let deadline = refresh
        .expires_at
        .min(refresh.family_created_at + services.refresh_family_absolute_ttl);
    let issued = if enrollment {
        services.jwt_issuer.issue_enrollment_session_access_token(
            input,
            user.group_roles.clone(),
            refresh.family_id,
            deadline,
        )
    } else {
        services.jwt_issuer.issue_session_access_token(
            input,
            None,
            user.group_roles.clone(),
            refresh.family_id,
            deadline,
        )
    };
    issued.map_err(|err| RestError::internal(err.to_string()))
}
