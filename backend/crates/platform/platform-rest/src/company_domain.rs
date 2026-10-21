//! Company-domain availability is a platform listing, including retired reservations.
use crate::{PlatformError, PlatformRestState};
use axum::{
    Extension, Json,
    extract::{Query, State},
    response::{IntoResponse, Response},
};
use console_platform_auth::AccessClaims;
use console_platform_authz::PlatformPrincipal;
use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct DomainQuery {
    slug: String,
}

pub(crate) async fn availability(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Extension(claims): Extension<AccessClaims>,
    Query(query): Query<DomainQuery>,
) -> Result<Response, PlatformError> {
    let mut tx = crate::listing_authority::begin(
        &state,
        &principal,
        &claims,
        "tenants",
        "platform principal cannot list tenants",
    )
    .await?;
    // The resolver uses the same domain syntax as identifier-first sign-in.
    if console_platform_auth::normalize_company_domain(&query.slug).as_deref()
        != Some(query.slug.as_str())
    {
        return Err(PlatformError::from_provisioning(
            console_platform_provisioning::ProvisioningError::SlugInvalid(
                "invalid company domain".into(),
            ),
        ));
    }
    let available = state
        .provisioner
        .company_domain_available_in_tx(
            &mut tx,
            principal.user_id,
            &query.slug,
            time::OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    tx.commit()
        .await
        .map_err(crate::listing_authority::storage_error)?;
    Ok(Json(serde_json::json!({ "available": available, "alias_days": console_platform_auth::SIGN_IN_ALIAS_DAYS })).into_response())
}

pub const TENANT_DOMAIN_REQUEST_PATH: &str = "/api/v1/tenant/company-domain/request";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DomainRequest {
    slug: String,
}

pub(crate) async fn request_domain(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<console_platform_authz::Principal>,
    headers: axum::http::HeaderMap,
    Json(body): Json<DomainRequest>,
) -> Result<Response, PlatformError> {
    let key = console_platform_db::idempotency::validate_idempotency_key(
        headers
            .get(console_platform_db::idempotency::IDEMPOTENCY_KEY_HEADER)
            .and_then(|h| h.to_str().ok()),
    )
    .map_err(PlatformError::validation)?;
    state
        .provisioner
        .request_company_domain(
            &state.pool,
            principal.user_id,
            principal.org_id,
            &body.slug,
            &key,
            time::OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;
    Ok(Json(serde_json::json!({"pending_domain":body.slug})).into_response())
}

pub(crate) async fn own_request(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<console_platform_authz::Principal>,
) -> Result<Response, PlatformError> {
    let pending = state
        .provisioner
        .own_company_domain_request(&state.pool, principal.user_id, principal.org_id)
        .await
        .map_err(PlatformError::from_provisioning)?;
    Ok(Json(serde_json::json!({"pending_domain":pending})).into_response())
}
