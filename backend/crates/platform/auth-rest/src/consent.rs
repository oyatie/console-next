use crate::context::request::enrollment_user_context;
use crate::context::request::required_privacy_consent_accepted_at;
use crate::dto::consent::PrivacyConsentAcceptRequest;
use crate::dto::consent::PrivacyConsentStatusResponse;
use crate::error::RestError;
use crate::limits::REQUIRED_PRIVACY_TERMS_VERSION;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use console_kernel_core::AuditAction;
use console_kernel_core::AuditEvent;
use console_kernel_core::TraceContext;
use console_kernel_core::UserId;
use console_platform_db::with_audit;
use time::OffsetDateTime;

/// Read whether the authenticated user has accepted the current required
/// first-login privacy/terms notice. Served as POST instead of GET to stay within
/// the auth router's existing verb/import surface and avoid changing generated
/// client assumptions for an authenticated pre-shell call.
pub(crate) async fn privacy_consent_status(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<PrivacyConsentStatusResponse>, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = enrollment_user_context(&state.pool, services, &headers).await?;
    let accepted_at = required_privacy_consent_accepted_at(&state.pool, org_id, user_id).await?;
    Ok(Json(PrivacyConsentStatusResponse {
        policy_version: REQUIRED_PRIVACY_TERMS_VERSION,
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
    let (user_id, org_id) = enrollment_user_context(&state.pool, services, &headers).await?;
    if body.policy_version != REQUIRED_PRIVACY_TERMS_VERSION {
        return Err(RestError::bad_request(
            "unsupported privacy consent version",
        ));
    }
    if !body.privacy_collection || !body.terms_of_service {
        return Err(RestError::bad_request(
            "required privacy and terms agreements must be accepted separately",
        ));
    }

    let now = OffsetDateTime::now_utc();
    let event = AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new("privacy.required_accept")
            .map_err(|err| RestError::internal(err.to_string()))?,
        "privacy_terms",
        REQUIRED_PRIVACY_TERMS_VERSION,
        TraceContext::generate(),
        now,
    )
    .with_org(org_id)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "policy_version": REQUIRED_PRIVACY_TERMS_VERSION,
            "privacy_collection": true,
            "terms_of_service": true,
            "optional_marketing": "not_requested",
            "gps_location": "separate_consent_flow",
        })),
    );

    with_audit::<_, (), RestError>(&state.pool, event, |_tx| Box::pin(async move { Ok(()) }))
        .await?;

    Ok(Json(PrivacyConsentStatusResponse {
        policy_version: REQUIRED_PRIVACY_TERMS_VERSION,
        accepted: true,
        accepted_at: Some(now),
    }))
}
