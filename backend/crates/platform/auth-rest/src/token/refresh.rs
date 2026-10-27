use crate::context::grants::resolve_feature_grant_keys_for_user_in_tx;
#[cfg(feature = "dev-auth")]
use crate::context::load::UserAuthContext;
use crate::context::load::load_user_auth_context_tx;
use crate::cookies::refresh_set_cookie;
use crate::cookies::select_refresh_credential;
use crate::cookies::wants_cookie_transport;
use crate::cookies::with_refresh_cookie;
use crate::dto::token::RefreshTokenRequest;
use crate::dto::token::TokenPairResponse;
use crate::error::RestError;
use crate::limits::RATE_LIMIT_PER_REFRESH_FAMILY;
use crate::rate_limit::RateLimitEndpoint;
use crate::rate_limit::rate_limit_key;
use crate::state::AuthRestState;
use crate::token::issue::issue_access_token;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::response::Response;
use console_platform_auth::AuthError;
use console_platform_auth::RefreshRotation;
use console_platform_db::DbError;
use time::OffsetDateTime;

/// Rate limited per refresh FAMILY (one session), not per IP: every browser in
/// an office shares an address, and the token itself is an unguessable secret.
pub(crate) async fn refresh_token(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<RefreshTokenRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    let cookie_mode = wants_cookie_transport(&headers);
    let refresh = select_refresh_credential(
        &headers,
        body.refresh_token,
        &services.rp_origin.origin().ascii_serialization(),
    )?
    .ok_or_else(|| RestError::unauthorized("missing refresh token"))?;
    let mut tx = state.pool.begin().await.map_err(DbError::Sqlx)?;
    let outcome = services
        .refresh_tokens
        .rotate_in_tx(
            &mut tx,
            &refresh,
            now,
            services.refresh_token_ttl,
            services.refresh_family_absolute_ttl,
        )
        .await
        .map_err(|err| match err {
            AuthError::Refresh(reason) => RestError::from_refresh(reason),
            other => RestError::internal(other.to_string()),
        })?;
    let issue = match outcome {
        RefreshRotation::Issued(issue) => issue,
        RefreshRotation::Terminal(reason) => {
            tx.commit().await.map_err(DbError::Sqlx)?;
            return Err(RestError::from_refresh(reason));
        }
    };
    // Counted in the rotation's own transaction (no second connection while
    // the family row is locked). Over budget: return before commit, so the
    // rotation and this count roll back and the presented token stays valid
    // for a later retry; the committed count stays at the cap for the window.
    rate_limit_key(
        tx.as_mut(),
        &format!("family:{}", issue.family_id),
        RateLimitEndpoint::Refresh,
        RATE_LIMIT_PER_REFRESH_FAMILY,
        now,
    )
    .await?;
    // Refresh is a pre-auth route (no tenant middleware); rotate_in_tx armed the
    // token's Company GUC. Keep current-user reads and JWT signing in that same
    // transaction so a signing failure never spends an undisclosed token.
    let mut user = load_user_auth_context_tx(&mut tx, issue.user_id).await?;
    if user.org_id != issue.org_id {
        return Err(RestError::unauthorized("refresh Account Company changed"));
    }
    user.feature_grants = resolve_feature_grant_keys_for_user_in_tx(&mut tx, &user).await?;
    let has_no_passkeys: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM auth_webauthn_credentials \
         WHERE user_id=$1 AND org_id=$2)",
    )
    .bind(issue.user_id)
    .bind(*issue.org_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    // A synthetic role-switch persona is a local development instrument, not a
    // real employee awaiting first-login enrollment. Preserve the production
    // zero-passkey rule for every ordinary user, including ordinary users in a
    // dev-auth binary; only the exact provisioner-owned persona identity bypasses
    // onboarding, and this branch does not exist in default/release builds.
    #[cfg(feature = "dev-auth")]
    let requires_passkey_setup = has_no_passkeys && !is_synthetic_dev_auth_persona(&user);
    #[cfg(not(feature = "dev-auth"))]
    let requires_passkey_setup = has_no_passkeys;
    // An OTP-bound family stays an enrollment session across rotation.
    let enrollment: bool = sqlx::query_scalar(
        "SELECT f.session_purpose IS NOT DISTINCT FROM 'enrollment' \
                OR EXISTS (SELECT 1 FROM auth_legacy_otp_family_sources s WHERE s.family_id=f.id) \
         FROM auth_refresh_token_families f WHERE f.id=$1",
    )
    .bind(issue.family_id)
    .fetch_one(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    let privacy_consent_accepted =
        crate::consent::session_consent_accepted(&mut tx, issue.family_id).await?;
    let access_token = issue_access_token(services, &user, &issue, enrollment)?;
    tx.commit().await.map_err(DbError::Sqlx)?;
    if cookie_mode {
        let max_age = (issue.expires_at - OffsetDateTime::now_utc()).whole_seconds();
        let cookie = refresh_set_cookie(issue.token.as_str(), max_age);
        let response = Json(TokenPairResponse {
            access_token,
            refresh_token: None,
            token_type: "Bearer",
            refresh_expires_at: issue.expires_at,
            requires_passkey_setup,
            privacy_consent_accepted,
            passkey_profile: None,
        })
        .into_response();
        Ok(with_refresh_cookie(response, cookie))
    } else {
        Ok(Json(TokenPairResponse {
            access_token,
            refresh_token: Some(issue.token.as_str().to_owned()),
            token_type: "Bearer",
            refresh_expires_at: issue.expires_at,
            requires_passkey_setup,
            privacy_consent_accepted,
            passkey_profile: None,
        })
        .into_response())
    }
}

/// Return whether this authenticated database user is the one synthetic
/// role-switch principal provisioned for its exact `(org, role)` tuple.
///
/// `DevPrincipalProvisioner` owns this collision-proof phone key. Refresh has
/// already authenticated and rotated a token family for `user`, and the user
/// context was reloaded under that token family's tenant before this predicate
/// runs. Requiring one role plus an exact marker (rather than a broad prefix)
/// prevents the dev-auth build from exempting ordinary zero-passkey users.
#[cfg(feature = "dev-auth")]
pub(crate) fn is_synthetic_dev_auth_persona(user: &UserAuthContext) -> bool {
    let [role] = user.roles.as_slice() else {
        return false;
    };
    user.username == format!("dev-auth:{}:{role}", user.org_id.as_uuid())
}
