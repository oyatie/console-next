use crate::context::request::enrollment_user_context;
use crate::context::request::required_privacy_consent_accepted_at;
use crate::context::request::{bearer_token, rest_error_from_request_context};
use crate::dto::consent::PrivacyConsentAcceptRequest;
use crate::dto::consent::PrivacyConsentStatusResponse;
use crate::error::RestError;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::Request;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use console_kernel_core::AuditAction;
use console_kernel_core::AuditEvent;
use console_kernel_core::TraceContext;
use console_kernel_core::UserId;
use console_platform_db::{with_audit, with_org_conn};
use console_platform_request_context::privacy::{self, ConsentRefs};
use console_platform_request_context::{RequestContextError, validate_current_claims};
use time::OffsetDateTime;

pub(crate) const PRIVACY_CONSENT_REQUIRED_CODE: &str = "privacy_consent_required";

/// Auth writes outside enrollment and session recovery use the same gate as business writes.
pub(crate) async fn require_app_write_consent(
    State(state): State<AuthRestState>,
    request: Request,
    next: Next,
) -> Result<Response, RestError> {
    if request.method().is_safe()
        || !request
            .headers()
            .contains_key(axum::http::header::AUTHORIZATION)
        || matches!(
            request.uri().path(),
            crate::SIGNUP_PATH
                | crate::PASSKEY_LOGIN_START_PATH
                | crate::PASSKEY_LOGIN_FINISH_PATH
                | crate::OTP_REDEEM_PATH
                | crate::DEVICE_LOGIN_START_PATH
                | crate::DEVICE_LOGIN_POLL_PATH
                | crate::PRIVACY_CONSENT_STATUS_PATH
                | crate::PRIVACY_CONSENT_ACCEPT_PATH
                | crate::TOKEN_REFRESH_PATH
                | crate::LOGOUT_PATH
                | crate::GROUP_ADMIN_TENANT_CONTEXT_EXIT_PATH
        )
    {
        return Ok(next.run(request).await);
    }
    #[cfg(feature = "dev-auth")]
    if request.uri().path() == crate::DEV_AUTH_SESSION_PATH {
        return Ok(next.run(request).await);
    }
    let services = state.services()?;
    let claims = services
        .jwt_verifier
        .verify_access_token(bearer_token(request.headers())?)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    if !claims.enrollment {
        validate_current_claims(&state.pool, &claims)
            .await
            .map_err(rest_error_from_request_context)?;
        privacy::ensure_write_consent(
            &state.pool,
            &services.jwt_verifier,
            request.headers(),
            request.method(),
        )
        .await
        .map_err(|error| match error {
            RequestContextError::AccessScope(error)
                if error.code == Some(PRIVACY_CONSENT_REQUIRED_CODE) =>
            {
                RestError {
                    status: axum::http::StatusCode::FORBIDDEN,
                    code: PRIVACY_CONSENT_REQUIRED_CODE,
                    message: error.message,
                }
            }
            error => rest_error_from_request_context(error),
        })?;
    }
    Ok(next.run(request).await)
}

/// Verifies that the required privacy notice and terms have been accepted by this user
/// in this organization. If not yet accepted, refuses with `privacy_consent_required` (403).
/// Returns the timestamp of acceptance when valid.
pub(crate) async fn ensure_privacy_consent_accepted(
    pool: &sqlx::PgPool,
    org_id: console_kernel_core::OrgId,
    user_id: uuid::Uuid,
) -> Result<OffsetDateTime, RestError> {
    let accepted_at = required_privacy_consent_accepted_at(pool, org_id, user_id).await?;
    match accepted_at {
        Some(at) => Ok(at),
        None => Err(RestError {
            status: axum::http::StatusCode::FORBIDDEN,
            code: PRIVACY_CONSENT_REQUIRED_CODE,
            message: "required privacy notice must be accepted before personal data write"
                .to_string(),
        }),
    }
}

/// Read whether the authenticated user has accepted the current required
/// first-login privacy/terms notice. Served as POST instead of GET to stay within
/// the auth router's existing verb/import surface and avoid changing generated
/// client assumptions for an authenticated pre-shell call.
pub(crate) async fn privacy_consent_status(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<PrivacyConsentStatusResponse>, RestError> {
    let services = state.services()?;
    let claims = services
        .jwt_verifier
        .verify_access_token(bearer_token(&headers)?)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    let (user, org) = validate_current_claims(&state.pool, &claims)
        .await
        .map_err(rest_error_from_request_context)?;
    let user_id = *user.as_uuid();
    let org_id = claims.actor_session.map_or(org, |actor| actor.home_org);
    let refs = with_org_conn(&state.pool, org_id, |tx| {
        Box::pin(async move {
            privacy::documents_in_tx(tx)
                .await
                .map(|d| d.references())
                .map_err(document_error)
        })
    })
    .await?;
    let accepted_at = required_privacy_consent_accepted_at(&state.pool, org_id, user_id).await?;
    Ok(Json(PrivacyConsentStatusResponse {
        policy_version: refs.privacy.version.clone(),
        privacy: refs.privacy,
        terms: refs.terms,
        accepted: accepted_at.is_some(),
        accepted_at,
    }))
}

/// Persist required first-login privacy/terms acceptance as an append-only,
/// tenant-scoped audit event. No marketing/location consent is collected here:
/// those remain separate optional flows.
pub(crate) async fn accept_privacy_consent(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<PrivacyConsentAcceptRequest>,
) -> Result<Json<PrivacyConsentStatusResponse>, RestError> {
    let services = state.services()?;
    let (user_id, org_id, _) = enrollment_user_context(&state.pool, services, &headers).await?;
    if !body.privacy_collection || !body.terms_of_service {
        return Err(RestError::bad_request(
            "required privacy and terms agreements must be accepted separately",
        ));
    }

    let refs = ConsentRefs {
        privacy: body.privacy,
        terms: body.terms,
    };
    let now = OffsetDateTime::now_utc();
    let event = AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new("privacy.required_accept")
            .map_err(|err| RestError::internal(err.to_string()))?,
        "privacy_terms",
        &refs.privacy.version,
        TraceContext::generate(),
        now,
    )
    .with_org(org_id)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "policy_version": refs.privacy.version,
            "privacy": refs.privacy,
            "terms": refs.terms,
            "accepted_at": now.format(&time::format_description::well_known::Rfc3339)
                .map_err(|e| RestError::internal(e.to_string()))?,
            "privacy_collection": true,
            "terms_of_service": true,
            "optional_marketing": "not_requested",
            "gps_location": "separate_consent_flow",
        })),
    );

    let accepted_refs = refs.clone();
    let snapshot = event.after.clone();
    with_audit::<_, (), RestError>(&state.pool, event, move |tx| Box::pin(async move {
        let current = privacy::documents_in_tx(tx).await.map_err(document_error)?.references();
        if current != accepted_refs {
            return Err(RestError { status: axum::http::StatusCode::CONFLICT,
                code: "terms_text_changed", message: "review the current published documents".into() });
        }
        sqlx::query("UPDATE auth_refresh_token_families SET privacy_acceptance=$3 WHERE org_id=$1 AND user_id=$2")
            .bind(org_id.as_uuid()).bind(user_id).bind(snapshot)
            .execute(tx.as_mut()).await.map_err(|e| RestError::internal(e.to_string()))?;
        Ok(())
    })).await?;

    Ok(Json(PrivacyConsentStatusResponse {
        policy_version: refs.privacy.version.clone(),
        privacy: refs.privacy,
        terms: refs.terms,
        accepted: true,
        accepted_at: Some(now),
    }))
}

fn document_error(error: sqlx::Error) -> RestError {
    match error {
        sqlx::Error::RowNotFound => RestError {
            status: axum::http::StatusCode::CONFLICT,
            code: "terms_not_published",
            message: "required documents are not published".into(),
        },
        error => RestError::internal(error.to_string()),
    }
}
