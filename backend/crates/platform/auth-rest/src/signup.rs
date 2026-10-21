use crate::dto::otp::SignupRequest;
use crate::dto::otp::SignupResponse;
use crate::error::RestError;
use crate::limits::DEFAULT_SIGNUP_OTP_TTL;
use crate::rate_limit::RateLimitEndpoint;
use crate::rate_limit::rate_limit;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::Extension;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use console_platform_request_context::TrustedClientIp;
use time::Duration;
use time::OffsetDateTime;

/// Open self-service signup (#38): create a new low-privilege MEMBER account and
/// email it a one-time sign-in code.
///
/// UNAUTHENTICATED and rate-limited (`Signup` bucket). Creates a fresh user in
/// the default (tenant #1) org with the single lowest-privilege `MEMBER` role, mints a
/// first-sign-in OTP via the same bootstrap machinery the admin path uses, and
/// delivers it over email (the stub sender logs it in dev/e2e). The response
/// reveals nothing — it always reports `accepted` and never a token — so it is
/// not an account-existence oracle. The caller then redeems the emailed code via
/// `/auth/otp/redeem` and enrolls a passkey, reusing the existing flow unchanged.
pub(crate) async fn signup(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    Json(body): Json<SignupRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        RateLimitEndpoint::Signup,
        now,
    )
    .await?;

    let email = body.email.trim();
    let display_name = signup_display_name(email)?;
    let ttl = DEFAULT_SIGNUP_OTP_TTL;
    // R25: with no way to deliver the code, refuse before writing anything;
    // otherwise every call leaves an orphan account behind.
    if !services.email_sender.can_send() {
        return Err(RestError::unavailable("sign-up is unavailable"));
    }

    let issue = services
        .bootstrap_credentials
        .signup_open_member(&state.pool, &display_name, now, ttl)
        .await
        .map_err(RestError::from_provisioning)?;

    // Deliver the code out-of-band. The stub sender logs it (dev/e2e read it from
    // the backend log); a real SMTP sender relays it. A delivery failure is a 502
    // — the account + code exist, but we could not hand the code to the user.
    services
        .email_sender
        .send_otp(email, issue.token.as_str(), duration_to_std(ttl))
        .await
        .map_err(|err| {
            tracing::error!(error = %err, "sign-up verification email failed");
            RestError::bad_gateway("could not send the verification email")
        })?;

    Ok((
        StatusCode::ACCEPTED,
        Json(SignupResponse { accepted: true }),
    )
        .into_response())
}

/// Derive a human display name from the signup email: validate it has exactly one
/// `@` with a non-empty local part and a dotted domain, then use the local part
/// as the label. Keeps the (no-email-column) `users` row readable while the email
/// itself is only used to deliver the OTP.
pub(crate) fn signup_display_name(email: &str) -> Result<String, RestError> {
    let (local, domain) = email
        .split_once('@')
        .ok_or_else(|| RestError::bad_request("a valid email address is required"))?;
    let local_ok = !local.is_empty() && local.len() <= 64;
    let domain_ok = domain.len() >= 3
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.');
    if !local_ok || !domain_ok || email.len() > 320 {
        return Err(RestError::bad_request("a valid email address is required"));
    }
    Ok(local.to_owned())
}

/// Convert a `time::Duration` to a `std::time::Duration` for the email port,
/// clamping any (impossible here) negative value to zero.
pub(crate) fn duration_to_std(ttl: Duration) -> std::time::Duration {
    std::time::Duration::from_secs(ttl.whole_seconds().max(0) as u64)
}
