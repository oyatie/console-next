use crate::error::RestError;
use crate::limits::DEFAULT_OTP_TTL;
use crate::limits::MAX_OTP_TTL;
use crate::state::AuthServices;
use axum::http::HeaderMap;
use axum::http::header;
use console_kernel_core::KernelError;
use console_kernel_core::OrgId;
use console_platform_authz::Principal;
use sqlx::PgPool;
use time::Duration;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) async fn ensure_registration_ceremony_owner(
    pool: &PgPool,
    ceremony_id: Uuid,
    user_id: Uuid,
) -> Result<(), RestError> {
    let owner: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT user_id
        FROM auth_webauthn_ceremonies
        WHERE id = $1
          AND ceremony_kind = 'registration'
          AND consumed_at IS NULL
          AND expires_at > now()
        "#,
    )
    .bind(ceremony_id)
    // rls-arming: ok auth_webauthn_ceremonies is a global pre-auth table (no org_id, no RLS)
    .fetch_optional(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?
    .flatten();

    match owner {
        Some(owner) if owner == user_id => Ok(()),
        Some(_) => Err(RestError::unauthorized(
            "registration ceremony belongs to a different user",
        )),
        None => Err(RestError::unauthorized(
            "registration ceremony not found or expired",
        )),
    }
}

/// Verify the bearer token and return BOTH the authenticated user id AND the
/// tenant from the verified `org` claim.
///
/// The passkey registration/start paths are pre-auth-middleware (no
/// `app.current_org` is armed by the router), but the caller IS authenticated:
/// the verified token carries the tenant. Using the JWT's org — never a `users`
/// read under RLS — breaks the chicken-and-egg and stamps every passkey write
/// with the correct tenant.
pub(crate) async fn authenticated_user_context(
    pool: &PgPool,
    services: &AuthServices,
    headers: &HeaderMap,
) -> Result<(Uuid, OrgId), RestError> {
    let (user_id, org_id, _) = user_context(pool, services, headers, false).await?;
    Ok((user_id, org_id))
}

/// [`authenticated_user_context`] that also admits an OTP enrollment session
/// (`enrollment` claim) — only for the [`ENROLLMENT_ROUTE_PATHS`] handlers.
pub(crate) async fn enrollment_user_context(
    pool: &PgPool,
    services: &AuthServices,
    headers: &HeaderMap,
) -> Result<(Uuid, OrgId, bool), RestError> {
    user_context(pool, services, headers, true).await
}

pub(crate) async fn user_context(
    pool: &PgPool,
    services: &AuthServices,
    headers: &HeaderMap,
    allow_enrollment: bool,
) -> Result<(Uuid, OrgId, bool), RestError> {
    let token = bearer_token(headers)?;
    let claims = services
        .jwt_verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    if claims.tenant_context.is_some()
        || claims.actor_session.is_some()
        || claims.view_as
        || claims.read_only
    {
        return Err(RestError::forbidden(
            "delegated sessions cannot manage account credentials or consent",
        ));
    }
    let (user, org) = console_platform_request_context::validate_current_claims(pool, &claims)
        .await
        .map_err(rest_error_from_request_context)?;
    // An enrollment session reaches only the enrollment surface, here as well
    // as at the app's path layer.
    if claims.enrollment && !allow_enrollment {
        return Err(RestError::passkey_required());
    }
    Ok((*user.as_uuid(), org, claims.enrollment))
}

pub(crate) fn session_family_from_headers(
    services: &AuthServices,
    headers: &HeaderMap,
) -> Result<Uuid, RestError> {
    let claims = services
        .jwt_verifier
        .verify_access_token(bearer_token(headers)?)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    claims
        .validate_expiry()
        .map_err(|_| RestError::unauthorized("session expired"))?;
    claims
        .session_family_id
        .ok_or_else(|| RestError::unauthorized("missing session family"))
}

pub(crate) async fn required_privacy_consent_accepted_at(
    pool: &PgPool,
    org_id: OrgId,
    user_id: Uuid,
) -> Result<Option<OffsetDateTime>, RestError> {
    console_platform_request_context::privacy::accepted_at(pool, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Result<&str, RestError> {
    let header_value = headers
        .get(header::AUTHORIZATION)
        .ok_or_else(|| RestError::unauthorized("missing bearer token"))?
        .to_str()
        .map_err(|_| RestError::unauthorized("invalid authorization header"))?;
    header_value
        .strip_prefix("Bearer ")
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| RestError::unauthorized("authorization header must use Bearer scheme"))
}

/// Resolve the admin-supplied OTP TTL, defaulting to 24h and rejecting
/// non-positive or absurdly large values.
pub(crate) fn resolve_otp_ttl(ttl_seconds: Option<i64>) -> Result<Duration, RestError> {
    let Some(secs) = ttl_seconds else {
        return Ok(DEFAULT_OTP_TTL);
    };
    if secs <= 0 {
        return Err(RestError::bad_request("ttl_seconds must be positive"));
    }
    let ttl = Duration::seconds(secs);
    if ttl > MAX_OTP_TTL {
        return Err(RestError::bad_request(
            "ttl_seconds exceeds the maximum allowed lifetime",
        ));
    }
    Ok(ttl)
}

// ---------------------------------------------------------------------------
// Authorization principal (for the admin issue-OTP endpoint).
// ---------------------------------------------------------------------------

pub(crate) async fn principal_from_headers(
    pool: &PgPool,
    services: &AuthServices,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    console_platform_request_context::resolve_principal(&services.jwt_verifier, pool, headers)
        .await
        .map_err(rest_error_from_request_context)
}

pub(crate) fn rest_error_from_request_context(
    err: console_platform_request_context::RequestContextError,
) -> RestError {
    match err {
        console_platform_request_context::RequestContextError::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for auth API")
        }
        console_platform_request_context::RequestContextError::WrongTokenTier => {
            RestError::from_kernel(KernelError::forbidden(
                "token tier is not valid for this route",
            ))
        }
        console_platform_request_context::RequestContextError::AccessScope(error) => {
            RestError::from_kernel(error)
        }
        console_platform_request_context::RequestContextError::BranchScope(message)
        | console_platform_request_context::RequestContextError::EffectivePolicy(message) => {
            RestError::from_kernel(KernelError::internal(message))
        }
        console_platform_request_context::RequestContextError::MissingOrg => {
            RestError::from_kernel(KernelError::internal(
                "no tenant context is bound to the current request",
            ))
        }
        console_platform_request_context::RequestContextError::MissingBearer => {
            RestError::unauthorized("missing or malformed bearer token")
        }
        console_platform_request_context::RequestContextError::InvalidToken => {
            RestError::unauthorized("invalid bearer token")
        }
        console_platform_request_context::RequestContextError::InvalidClaim(message) => {
            RestError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
}
