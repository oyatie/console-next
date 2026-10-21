use crate::audit::auth_audit_event;
use crate::context::load::load_user_auth_context_tx;
use crate::context::request::authenticated_user_context;
use crate::context::request::bearer_token;
use crate::device_login::token::hash_device_login_token;
use crate::device_login::token::normalize_device_login_token;
use crate::device_login::tx::ensure_handoff_company_active_tx;
use crate::device_login::tx::lock_handoff_account_tx;
use crate::device_login::tx::lock_handoff_tx;
use crate::dto::device::DeviceLoginApproveRequest;
use crate::dto::device::DeviceLoginApproveSessionRequest;
use crate::error::RestError;
use crate::rate_limit::RateLimitEndpoint;
use crate::rate_limit::passkey_error;
use crate::rate_limit::rate_limit;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::Extension;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use console_platform_db::DbError;
use console_platform_db::insert_audit_event;
use console_platform_request_context::TrustedClientIp;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) async fn approve_device_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    Json(body): Json<DeviceLoginApproveRequest>,
) -> Result<StatusCode, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        RateLimitEndpoint::DeviceLoginApprove,
        now,
    )
    .await?;

    let approve_token = normalize_device_login_token(&body.approve_token, "console_dla_")?;
    let approve_hash = hash_device_login_token(&approve_token);

    let pending = sqlx::query(
        r#"
        SELECT id, target_user_id, target_org_id
        FROM auth_device_login_handoffs
        WHERE approve_token_hash = $1
          AND approved_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > $2
        "#,
    )
    .bind(&approve_hash)
    .bind(now)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let Some(pending) = pending else {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    };

    let handoff_id: Uuid = pending.try_get("id").map_err(DbError::Sqlx)?;

    let mut tx = state.pool.begin().await.map_err(DbError::Sqlx)?;
    let outcome = services
        .passkeys
        .finish_authentication_in_tx(&mut tx, body.ceremony_id, body.credential)
        .await
        .map_err(|err| passkey_error(err, "passkey sign-in failed"))?;
    let current = lock_handoff_tx(&mut tx, handoff_id).await?;
    for field in ["target_user_id", "target_org_id"] {
        if current
            .try_get::<Option<Uuid>, _>(field)
            .map_err(DbError::Sqlx)?
            != pending
                .try_get::<Option<Uuid>, _>(field)
                .map_err(DbError::Sqlx)?
        {
            return Err(RestError::unauthorized("login handoff identity changed"));
        }
    }
    let now = console_platform_auth::authentication_time_tx(&mut tx, now)
        .await
        .map_err(DbError::Sqlx)?;

    let updated = sqlx::query(
        r#"
        UPDATE auth_device_login_handoffs
        SET approved_at = $2,
            approved_user_id = $3,
            approved_org_id = $4,
            approved_passkey_id = $5
        WHERE approve_token_hash = $1 AND id = $6
          AND approved_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > $2
          AND (target_user_id IS NULL OR target_user_id = $3)
          AND (target_org_id IS NULL OR target_org_id = $4)
        RETURNING id
        "#,
    )
    .bind(&approve_hash)
    .bind(now)
    .bind(outcome.user_id)
    .bind(*outcome.org_id.as_uuid())
    .bind(outcome.passkey_id)
    .bind(handoff_id)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    if updated.is_none() {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    }

    let audit = auth_audit_event(
        outcome.org_id,
        outcome.user_id,
        "auth.device_login.approve",
        serde_json::json!({
            "handoff_id": handoff_id,
            "passkey_id": outcome.passkey_id,
        }),
    )?;
    insert_audit_event(&mut tx, &audit).await?;
    tx.commit().await.map_err(DbError::Sqlx)?;

    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn approve_device_login_session(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    Json(body): Json<DeviceLoginApproveSessionRequest>,
) -> Result<StatusCode, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        RateLimitEndpoint::DeviceLoginApprove,
        now,
    )
    .await?;

    let approve_token = normalize_device_login_token(&body.approve_token, "console_dla_")?;
    let approve_hash = hash_device_login_token(&approve_token);
    let pending: Option<(Uuid, Option<Uuid>, Option<Uuid>)> = sqlx::query_as(
        "SELECT id, target_user_id, target_org_id FROM auth_device_login_handoffs WHERE approve_token_hash=$1")
        .bind(&approve_hash).fetch_optional(&state.pool).await.map_err(DbError::Sqlx)?;
    let Some((handoff_id, Some(target_user), Some(target_org))) = pending else {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    };
    let (user_id, org_id) = authenticated_user_context(&state.pool, services, &headers).await?;
    // Authentication waits on the Account lock; retain the original target
    // and recheck it in the locked UPDATE instead of adopting a changed target.
    if target_user != user_id || target_org != *org_id.as_uuid() {
        return Err(RestError::unauthorized(
            "login handoff belongs to another Account",
        ));
    }
    let mut tx = state.pool.begin().await.map_err(DbError::Sqlx)?;
    lock_handoff_account_tx(&mut tx, org_id, user_id).await?;
    lock_handoff_tx(&mut tx, handoff_id).await?;
    // The earlier bearer check can race logout while waiting for the Account.
    // Keep the exact family locked through approval so a revoked session cannot
    // turn into a new desktop login after its logout has committed.
    let claims = services
        .jwt_verifier
        .verify_access_token(bearer_token(&headers)?)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    claims
        .validate_expiry()
        .map_err(|_| RestError::unauthorized("session expired"))?;
    let family_id = claims
        .session_family_id
        .ok_or_else(|| RestError::unauthorized("missing session family"))?;
    let current_user = load_user_auth_context_tx(&mut tx, user_id).await?;
    let live_family: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM auth_refresh_token_families WHERE id=$1 AND user_id=$2 AND org_id=$3 AND revoked_at IS NULL FOR SHARE",
    )
    .bind(family_id)
    .bind(user_id)
    .bind(*org_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    if live_family != Some(true)
        || current_user.authz_subject_version != claims.authz_subject_version
        || current_user.session_generation != claims.session_generation
        || claims
            .roles
            .iter()
            .any(|role| !current_user.roles.contains(role))
    {
        return Err(RestError::unauthorized("session authority changed"));
    }
    let latest_passkey_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM auth_webauthn_credentials WHERE user_id=$1 AND org_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1")
        .bind(user_id).bind(*org_id.as_uuid()).fetch_optional(tx.as_mut()).await.map_err(DbError::Sqlx)?;
    if latest_passkey_id.is_none() {
        return Err(RestError::forbidden(
            "desktop login approval requires an enrolled passkey",
        ));
    }
    let now = console_platform_auth::authentication_time_tx(&mut tx, now)
        .await
        .map_err(DbError::Sqlx)?;
    ensure_handoff_company_active_tx(&mut tx, org_id).await?;
    claims
        .validate_expiry()
        .map_err(|_| RestError::unauthorized("session expired"))?;

    let approved = sqlx::query(
        r#"
        UPDATE auth_device_login_handoffs
        SET approved_at = $2,
            approved_user_id = $3,
            approved_org_id = $4,
            approved_passkey_id = $5
        WHERE approve_token_hash = $1 AND id = $6
          AND approved_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > $2
          AND target_user_id = $3
          AND target_org_id = $4
        RETURNING id, approved_passkey_id
        "#,
    )
    .bind(&approve_hash)
    .bind(now)
    .bind(user_id)
    .bind(*org_id.as_uuid())
    .bind(latest_passkey_id)
    .bind(handoff_id)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    let Some(approved) = approved else {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    };
    let handoff_id: Uuid = approved.try_get("id").map_err(DbError::Sqlx)?;
    let passkey_id: Option<Uuid> = approved
        .try_get("approved_passkey_id")
        .map_err(DbError::Sqlx)?;

    let audit = auth_audit_event(
        org_id,
        user_id,
        "auth.device_login.approve_session",
        serde_json::json!({
            "handoff_id": handoff_id,
            "passkey_id": passkey_id,
        }),
    )?;
    insert_audit_event(&mut tx, &audit).await?;
    tx.commit().await.map_err(DbError::Sqlx)?;

    Ok(StatusCode::NO_CONTENT)
}
