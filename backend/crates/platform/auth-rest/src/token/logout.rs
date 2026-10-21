use crate::cookies::refresh_clear_cookie;
use crate::cookies::select_refresh_credential;
use crate::cookies::wants_cookie_transport;
use crate::cookies::with_refresh_cookie;
use crate::dto::token::LogoutRequest;
use crate::error::RestError;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use time::OffsetDateTime;

pub(crate) async fn logout(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<LogoutRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let cookie_mode = wants_cookie_transport(&headers);
    // Read the token from the cookie (web) or the body (mobile). A logout with no
    // token is a no-op success: the session is already gone client-side, and we
    // still clear the cookie for the web client below.
    let refresh = select_refresh_credential(
        &headers,
        body.refresh_token,
        &services.rp_origin.origin().ascii_serialization(),
    )?;
    if let Some(refresh) = refresh.as_deref() {
        services
            .refresh_tokens
            .revoke_family_for_logout(&state.pool, refresh, OffsetDateTime::now_utc())
            .await
            .map_err(RestError::from_refresh)?;
    }
    // Always clear the cookie for the web transport so a stale token cannot linger
    // in the browser after the family is revoked.
    if cookie_mode {
        let response = StatusCode::NO_CONTENT.into_response();
        Ok(with_refresh_cookie(
            response,
            refresh_clear_cookie(services.cookie_secure),
        ))
    } else {
        Ok(StatusCode::NO_CONTENT.into_response())
    }
}
