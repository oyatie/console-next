// SPDX-License-Identifier: LicenseRef-Proprietary
//! Correlate errors in logs/traces; the error path never touches the database.
use super::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use console_kernel_core::OrgId;
use console_platform_authz::cedar_pbac::actions::support_reference;
use console_platform_authz::{Action, Feature, PlatformPrincipal, Principal, authorize_org_wide};
use console_platform_request_context::{with_platform_context, with_request_context};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const TENANT_PATH: &str = "/api/v1/support-references/{reference}";
const PLATFORM_PATH: &str = "/api/platform/support-references/{reference}";
pub(crate) const PATHS: &[&str] = &[TENANT_PATH, PLATFORM_PATH];
pub const OPERATIONS: &[console_platform_rest::PlatformRouteOperation] = &[
    console_platform_rest::PlatformRouteOperation {
        method: "GET",
        path: TENANT_PATH,
    },
    console_platform_rest::PlatformRouteOperation {
        method: "GET",
        path: PLATFORM_PATH,
    },
];

pub(crate) fn router(state: &AppState, pool: &PgPool) -> Router {
    let tenant = with_request_context(
        Router::new()
            .route(TENANT_PATH, get(resolve_tenant))
            .with_state(state.clone()),
        state.jwt_verifier.clone(),
        pool.clone(),
    );
    let platform = with_platform_context(
        Router::new()
            .route(PLATFORM_PATH, get(resolve_platform))
            .with_state(state.clone()),
        state.jwt_verifier.clone(),
        pool.clone(),
    );
    tenant.merge(platform)
}

/// Identity comes only from a verified token; unauthenticated errors belong to ops.
pub(crate) fn request_org(
    state: &AppState,
    authorization: Option<&axum::http::HeaderValue>,
) -> OrgId {
    authorization
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .and_then(|token| state.jwt_verifier.as_ref()?.verify_access_token(token).ok())
        .and_then(|claims| claims.org.parse().ok())
        .unwrap_or_else(OrgId::platform)
}

pub(crate) fn issue(
    state: &AppState,
    org: OrgId,
    route: &str,
    reference: &str,
    trace_id: &str,
) -> String {
    let at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default();
    let release = state.web_release.as_ref();
    let span = tracing::Span::current();
    span.record("support_ref", reference);
    span.record("release", release);
    span.record("org_id", org.to_string());
    tracing::warn!(support_ref = reference, trace_id, release, route_template = route,
        org_id = %org, support_ref_at = %at, "support reference");
    at
}

fn not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "support_reference_not_found",
        "Support reference not found",
    )
}

fn authorize(actor: &str, org: OrgId, target: OrgId, grant: bool) -> Result<(), ApiError> {
    let (allowed, reasons) =
        support_reference::decide(actor, &org.to_string(), &target.to_string(), grant).map_err(
            |error| {
                tracing::error!(%error, "support reference Cedar decision failed");
                ApiError::internal("internal server error")
            },
        )?;
    if allowed {
        return Ok(());
    }
    let code = if reasons
        .iter()
        .any(|r| r == "support_reference_cross_tenant_denied")
    {
        "support_reference_cross_tenant_denied"
    } else {
        "support_reference_grant_required"
    };
    Err(ApiError::new(
        StatusCode::FORBIDDEN,
        code,
        match code {
            "support_reference_cross_tenant_denied" => {
                "Support reference belongs to another customer account"
            }
            _ => "A diagnostic support grant is required",
        },
    ))
}

async fn read(state: &AppState, reference: &str) -> Result<Value, ApiError> {
    if reference.len() != 32
        || !reference.bytes().all(|c| c.is_ascii_hexdigit())
        || reference.bytes().all(|c| c == b'0')
    {
        return Err(not_found());
    }
    let endpoint = state
        .config
        .support_log_query_url
        .as_ref()
        .ok_or_else(|| ApiError::service_unavailable("Support log store is not configured"))?;
    // Only a validated correlation id enters LogsQL; return metadata, never log payloads.
    let query = format!(
        "fields.support_ref:=\"{reference}\" | fields fields.support_ref, fields.trace_id, fields.release, fields.route_template, fields.org_id, fields.support_ref_at"
    );
    let mut url = url::Url::parse(endpoint)
        .map_err(|_| ApiError::service_unavailable("Invalid support log endpoint"))?;
    url.query_pairs_mut()
        .extend_pairs([("query", query.as_str()), ("limit", "1")]);
    let response = state
        .support_log_client
        .get(url)
        .send()
        .await
        .map_err(store_error)?
        .error_for_status()
        .map_err(store_error)?;
    let body = response.text().await.map_err(store_error)?;
    let line = body
        .lines()
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(not_found)?;
    let fields: Value = serde_json::from_str(line).map_err(|_| {
        ApiError::service_unavailable("Support log store returned invalid metadata")
    })?;
    let mut result = json!({});
    for key in [
        "support_ref",
        "trace_id",
        "release",
        "route_template",
        "org_id",
        "support_ref_at",
    ] {
        let value = fields
            .get(format!("fields.{key}"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ApiError::service_unavailable("Support log store returned incomplete metadata")
            })?;
        result[key] = value.into();
    }
    if result["support_ref"] != reference {
        return Err(not_found());
    }
    Ok(result)
}

fn store_error(error: reqwest::Error) -> ApiError {
    tracing::error!(%error, "support log store unavailable");
    ApiError::service_unavailable("Support log store unavailable")
}

async fn resolve_tenant(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(reference): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let grant = authorize_org_wide(&principal, Action::new(Feature::AuditLogRead)).is_ok();
    authorize(
        &principal.user_id.to_string(),
        principal.org_id,
        principal.org_id,
        grant,
    )?;
    let record = read(&state, &reference).await?;
    let org = record["org_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(not_found)?;
    authorize(&principal.user_id.to_string(), principal.org_id, org, grant)?;
    Ok(Json(record))
}
async fn resolve_platform(
    State(state): State<AppState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path(reference): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let grant = principal
        .authorize(console_platform_authz::PlatformFeature::TenantHealthRead)
        .is_ok();
    authorize(
        &principal.user_id.to_string(),
        OrgId::platform(),
        OrgId::platform(),
        grant,
    )?;
    Ok(Json(read(&state, &reference).await?))
}

#[cfg(test)]
#[path = "support_reference_tests.rs"]
mod tests;
