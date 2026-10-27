use crate::audit::auth_audit_event;
use crate::context::grants::resolve_feature_grant_keys_for_user_in_tx;
use crate::context::load::load_user_auth_context_tx;
use crate::device_login::token::device_login_status;
use crate::device_login::token::device_login_token_response;
use crate::device_login::token::hash_device_login_token;
use crate::device_login::token::normalize_device_login_token;
use crate::device_login::tx::ensure_handoff_company_active_tx;
use crate::device_login::tx::lock_handoff_account_tx;
use crate::device_login::tx::lock_handoff_tx;
use crate::dto::device::DeviceLoginPollRequest;
use crate::error::RestError;
use crate::rate_limit::RateLimitEndpoint;
use crate::rate_limit::rate_limit;
use crate::state::AuthRestState;
use crate::token::issue::issue_token_pair_in_tx;
use axum::Json;
use axum::extract::Extension;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::response::Response;
use console_kernel_core::OrgId;
use console_platform_db::DbError;
use console_platform_db::insert_audit_event;
use console_platform_request_context::TrustedClientIp;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) async fn poll_device_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    Json(body): Json<DeviceLoginPollRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        RateLimitEndpoint::DeviceLoginPoll,
        now,
    )
    .await?;

    let poll_token = normalize_device_login_token(&body.poll_token, "console_dlp_")?;
    let poll_hash = hash_device_login_token(&poll_token);

    let status = sqlx::query(
        r#"
        SELECT id, expires_at, approved_at, consumed_at, approved_user_id, approved_org_id, approved_passkey_id, target_user_id, target_org_id
        FROM auth_device_login_handoffs
        WHERE poll_token_hash = $1
        "#,
    )
    .bind(&poll_hash)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    let Some(status) = status else {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    };
    let expires_at: OffsetDateTime = status.try_get("expires_at").map_err(DbError::Sqlx)?;
    let approved_at: Option<OffsetDateTime> =
        status.try_get("approved_at").map_err(DbError::Sqlx)?;
    let consumed_at: Option<OffsetDateTime> =
        status.try_get("consumed_at").map_err(DbError::Sqlx)?;

    if consumed_at.is_some() {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    }
    if expires_at <= now {
        return Ok(Json(device_login_status("expired")).into_response());
    }
    if approved_at.is_none() {
        return Ok(Json(device_login_status("pending")).into_response());
    }

    let handoff_id: Uuid = status.try_get("id").map_err(DbError::Sqlx)?;
    let user_id: Uuid = status
        .try_get::<Option<Uuid>, _>("approved_user_id")
        .map_err(DbError::Sqlx)?
        .ok_or_else(|| RestError::unauthorized("invalid login handoff"))?;
    let org_uuid: Uuid = status
        .try_get::<Option<Uuid>, _>("approved_org_id")
        .map_err(DbError::Sqlx)?
        .ok_or_else(|| RestError::unauthorized("invalid login handoff"))?;
    let mut tx = state.pool.begin().await.map_err(DbError::Sqlx)?;
    lock_handoff_account_tx(&mut tx, OrgId::from_uuid(org_uuid), user_id).await?;
    let current = lock_handoff_tx(&mut tx, handoff_id).await?;
    for field in [
        "approved_user_id",
        "approved_org_id",
        "approved_passkey_id",
        "target_user_id",
        "target_org_id",
    ] {
        if current
            .try_get::<Option<Uuid>, _>(field)
            .map_err(DbError::Sqlx)?
            != status
                .try_get::<Option<Uuid>, _>(field)
                .map_err(DbError::Sqlx)?
        {
            return Err(RestError::unauthorized("login handoff identity changed"));
        }
    }
    let now = console_platform_auth::authentication_time_tx(&mut tx, now)
        .await
        .map_err(DbError::Sqlx)?;
    ensure_handoff_company_active_tx(&mut tx, OrgId::from_uuid(org_uuid)).await?;

    let approved = sqlx::query(
        r#"
        UPDATE auth_device_login_handoffs
        SET consumed_at = $2
        WHERE poll_token_hash = $1 AND id = $3 AND approved_user_id = $4 AND approved_org_id = $5
          AND consumed_at IS NULL
          AND approved_at IS NOT NULL
          AND expires_at > $2
        RETURNING id, approved_user_id, approved_org_id, approved_passkey_id
        "#,
    )
    .bind(&poll_hash)
    .bind(now)
    .bind(handoff_id)
    .bind(user_id)
    .bind(org_uuid)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    let Some(approved) = approved else {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    };
    let handoff_id: Uuid = approved.try_get("id").map_err(DbError::Sqlx)?;
    let user_id: Uuid = approved
        .try_get::<Option<Uuid>, _>("approved_user_id")
        .map_err(DbError::Sqlx)?
        .ok_or_else(|| RestError::internal("approved login handoff missing user"))?;
    let org_uuid: Uuid = approved
        .try_get::<Option<Uuid>, _>("approved_org_id")
        .map_err(DbError::Sqlx)?
        .ok_or_else(|| RestError::internal("approved login handoff missing org"))?;
    let passkey_id: Option<Uuid> = approved
        .try_get("approved_passkey_id")
        .map_err(DbError::Sqlx)?;

    let mut user = load_user_auth_context_tx(&mut tx, user_id).await?;
    user.feature_grants = resolve_feature_grant_keys_for_user_in_tx(&mut tx, &user).await?;
    let tokens = issue_token_pair_in_tx(&mut tx, services, &user, false).await?;
    let audit = auth_audit_event(
        OrgId::from_uuid(org_uuid),
        user_id,
        "auth.device_login.consume",
        serde_json::json!({
            "handoff_id": handoff_id,
            "passkey_id": passkey_id,
            "refresh_family_id": tokens.family_id,
        }),
    )?;
    insert_audit_event(&mut tx, &audit).await?;
    tx.commit().await.map_err(DbError::Sqlx)?;

    Ok(device_login_token_response(tokens, &headers))
}
