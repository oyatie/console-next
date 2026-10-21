use crate::audit::auth_audit_event;
use crate::context::grants::resolve_feature_grant_keys_for_user_in_tx;
use crate::context::load::load_user_auth_context_tx;
use crate::context::request::authenticated_user_context;
use crate::device_login::token::hash_device_login_token;
use crate::device_login::token::hex_encode;
use crate::dto::passkey::LoginFinishRequest;
use crate::dto::passkey::LoginStartRequest;
use crate::dto::passkey::LoginStartResponse;
use crate::error::RestError;
use crate::limits::RATE_LIMIT_PER_CREDENTIAL;
use crate::limits::RATE_LIMIT_PER_IDENTIFIER;
use crate::rate_limit::RateLimitEndpoint;
use crate::rate_limit::floor_to_window;
use crate::rate_limit::increment_rate_bucket;
use crate::rate_limit::passkey_error;
use crate::rate_limit::rate_bucket_attempts;
use crate::rate_limit::rate_limit;
use crate::rate_limit::rate_limit_ip_key;
use crate::rate_limit::rate_limit_key;
use crate::state::AuthRestState;
use crate::token::issue::issue_token_pair_in_tx;
use axum::Json;
use axum::extract::Extension;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::header::AUTHORIZATION;
use axum::response::Response;
use console_platform_auth::normalize_sign_in_id;
use console_platform_db::DbError;
use console_platform_db::insert_audit_event;
use console_platform_request_context::TrustedClientIp;
use time::OffsetDateTime;

pub(crate) async fn start_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    body: Option<Json<LoginStartRequest>>,
) -> Result<Json<LoginStartResponse>, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        RateLimitEndpoint::LoginStart,
        now,
    )
    .await?;
    let identifier = body.and_then(|Json(body)| body.identifier);
    // A signed-in caller asking for a step-up: the challenge names only its own
    // credentials, so a non-resident key can confirm (decisions #33). A token
    // that does not verify (or a delegated session) falls back to usernameless;
    // every step-up verifier still checks the credential is the caller's.
    let caller = if headers.contains_key(AUTHORIZATION) {
        authenticated_user_context(&state.pool, services, &headers)
            .await
            .ok()
    } else {
        None
    };
    let ceremony = if let Some((user_id, org)) = caller {
        services
            .passkeys
            .start_own_authentication(&state.pool, org, user_id)
            .await
    } else if let Some(raw) = identifier {
        // Identifier first: the same answer shape for every identifier, known
        // or not; a syntax error is the only distinct refusal.
        let identifier = normalize_sign_in_id(&raw).ok_or_else(RestError::sign_in_id_invalid)?;
        let key = format!("id:{}", hex_encode(&hash_device_login_token(&identifier)));
        rate_limit_key(
            &state.pool,
            &key,
            RateLimitEndpoint::LoginStartIdentifier,
            RATE_LIMIT_PER_IDENTIFIER,
            now,
        )
        .await?;
        services
            .passkeys
            .start_identified_authentication(&state.pool, &identifier)
            .await
    } else {
        // Usernameless (autofill, the 「패스키로 로그인」 button): an empty
        // allowCredentials; the user is resolved at finish from the credential.
        services.passkeys.start_authentication(&state.pool).await
    }
    .map_err(|err| passkey_error(err, "passkey sign-in failed"))?;

    Ok(Json(LoginStartResponse {
        ceremony_id: ceremony.ceremony_id,
        challenge: serde_json::to_value(ceremony.challenge)
            .map_err(|err| RestError::internal(err.to_string()))?,
        expires_at: ceremony.expires_at,
    }))
}

pub(crate) async fn finish_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    Json(body): Json<LoginFinishRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let trusted_client_ip = trusted_client_ip.map(|Extension(ip)| ip);
    let now = OffsetDateTime::now_utc();
    // NAT-sized per-address throttle on every finish, verified or not.
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip,
        RateLimitEndpoint::LoginFinish,
        now,
    )
    .await?;
    // Failures only, per credential and address (hashed: the id is
    // client-supplied and unbounded): refuse while this sender is over the
    // cap, count only when verification fails.
    let failure_key = format!(
        "cred:{}:{}",
        hex_encode(&hash_device_login_token(&body.credential.id)),
        trusted_client_ip.map_or_else(String::new, rate_limit_ip_key)
    );
    if rate_bucket_attempts(
        &state.pool,
        &failure_key,
        RateLimitEndpoint::LoginFinishFailure,
        now,
    )
    .await?
        >= RATE_LIMIT_PER_CREDENTIAL
    {
        return Err(RestError::too_many_requests());
    }
    let mut tx = state.pool.begin().await.map_err(DbError::Sqlx)?;
    let outcome = match services
        .passkeys
        .finish_authentication_in_tx(&mut tx, body.ceremony_id, body.credential)
        .await
    {
        Ok(outcome) => outcome,
        Err(err) => {
            drop(tx);
            increment_rate_bucket(
                &state.pool,
                &failure_key,
                RateLimitEndpoint::LoginFinishFailure.as_str(),
                floor_to_window(now),
            )
            .await?;
            return Err(passkey_error(err, "passkey sign-in failed"));
        }
    };
    // Verification resolved and armed the credential's Company in this same
    // transaction. No proof, family, token or success audit survives a failure.
    let mut user = load_user_auth_context_tx(&mut tx, outcome.user_id).await?;
    user.feature_grants = resolve_feature_grant_keys_for_user_in_tx(&mut tx, &user).await?;
    let tokens = issue_token_pair_in_tx(&mut tx, services, &user, false).await?;
    let login_audit = auth_audit_event(
        outcome.org_id,
        outcome.user_id,
        "auth.login",
        serde_json::json!({
            "passkey_id": outcome.passkey_id,
            "refresh_family_id": tokens.family_id,
        }),
    )?;
    insert_audit_event(&mut tx, &login_audit).await?;
    let (name, display_name): (String, String) = sqlx::query_as(
        "SELECT s.login || '@' || o.slug, u.display_name || ' · ' || o.name || ' — ' || s.login || '@' || o.slug \
         FROM user_sign_in_ids s JOIN organizations o ON o.id=s.org_id \
         JOIN users u ON u.id=s.user_id AND u.org_id=s.org_id \
         WHERE s.user_id=$1 AND s.retired_at IS NULL",
    ).bind(outcome.user_id).fetch_one(tx.as_mut()).await.map_err(DbError::Sqlx)?;
    let profile = crate::dto::token::PasskeyProfile {
        user_id: outcome.user_id,
        name,
        display_name,
    };
    tx.commit().await.map_err(DbError::Sqlx)?;
    Ok(crate::cookies::token_pair_response_with_profile(
        tokens,
        &headers,
        services.cookie_secure,
        Some(profile),
    ))
}
