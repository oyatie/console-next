use crate::audit::record_anonymous_auth_audit;
use crate::device_login::token::generate_device_login_token;
use crate::device_login::token::hash_device_login_token;
use crate::dto::device::DeviceLoginStartResponse;
use crate::error::RestError;
use crate::limits::DEVICE_LOGIN_HANDOFF_TTL;
use crate::rate_limit::RateLimitEndpoint;
use crate::rate_limit::rate_limit;
use crate::state::AuthRestState;
use crate::urls::build_device_login_approve_url;
use axum::Json;
use axum::extract::Extension;
use axum::extract::State;
use axum::http::HeaderMap;
use console_platform_request_context::TrustedClientIp;
use time::OffsetDateTime;
use uuid::Uuid;

/// Start a desktop-login handoff that a phone passkey can approve.
///
/// This is NOT enrollment and does not mint a phone session. The desktop keeps a
/// poll token returned in the JSON body; the QR URL carries a distinct approve
/// token. The phone proves possession of an existing passkey against the approve
/// token, then the desktop poll token can be consumed exactly once for a normal
/// session.
pub(crate) async fn start_device_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
) -> Result<Json<DeviceLoginStartResponse>, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        RateLimitEndpoint::DeviceLoginStart,
        now,
    )
    .await?;

    let handoff_id = Uuid::new_v4();
    let poll_token = generate_device_login_token("console_dlp_");
    let approve_token = generate_device_login_token("console_dla_");
    let expires_at = now + DEVICE_LOGIN_HANDOFF_TTL;

    sqlx::query(
        r#"
        INSERT INTO auth_device_login_handoffs (
            id, poll_token_hash, approve_token_hash, issued_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(handoff_id)
    .bind(hash_device_login_token(&poll_token))
    .bind(hash_device_login_token(&approve_token))
    .bind(now)
    .bind(expires_at)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .execute(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    record_anonymous_auth_audit(
        &state.pool,
        "auth.device_login.start",
        serde_json::json!({
            "handoff_id": handoff_id,
            "expires_at": expires_at,
        }),
    )
    .await?;

    Ok(Json(DeviceLoginStartResponse {
        poll_token,
        approve_url: build_device_login_approve_url(&services.rp_origin, &approve_token),
        expires_at,
    }))
}
