//! Reason-code catalog REST surface (BW-07).
//!
//! - `GET   /api/v1/reason-codes?domain=`: the domain's catalog. Any signed-in
//!   member: every reason picker reads it.
//! - `POST  /api/v1/reason-codes`: add a tenant code (inline, no deploy).
//! - `PATCH /api/v1/reason-codes/{domain}/{code}`: switch a tenant code
//!   on/off or reorder it.
//! - `GET   /api/v1/reason-codes/stats`: per-column usage and the 기타 rate.

use crate::SettingsRestState;
use crate::error::ApiError;
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, patch};
use axum::{Json, Router};
use console_kernel_core::KernelError;
use console_platform_authz::cedar_pbac::enforce::enforce_action;
use console_platform_authz::cedar_pbac::facts::Facts;
use console_platform_authz::{AuthorizationResource, Feature, Principal};
use console_platform_request_context::current_audit_context;
use console_settings_application::Actor;
use console_settings_application::reason_codes::{AddReasonCode, UpdateReasonCode};
use console_settings_domain::code_lists::{ReasonDomain, parse_domain};
use serde::Deserialize;

pub const REASON_CODES_PATH: &str = "/api/v1/reason-codes";
pub const REASON_CODE_PATH: &str = "/api/v1/reason-codes/{domain}/{code}";
pub const REASON_CODE_STATS_PATH: &str = "/api/v1/reason-codes/stats";

pub const REASON_CODES_ROUTE_PATHS: &[&str] =
    &[REASON_CODES_PATH, REASON_CODE_PATH, REASON_CODE_STATS_PATH];

pub(crate) fn routes() -> Router<SettingsRestState> {
    Router::new()
        .route(REASON_CODES_PATH, get(catalog).post(add))
        .route(REASON_CODE_PATH, patch(update))
        .route(REASON_CODE_STATS_PATH, get(stats))
}

/// Who may manage a domain's catalog is Cedar's (`reason_code_manage`, with
/// the roster `tenant_extensible` flag as `domain_tenant_extensible`, the one
/// fact GOV-CED-1 declares). Denies until that schema is enrolled.
// the stats read (no domain) stays deny-all; it is a
// `policy_config_view` read (governance design §2.2), a GOV-CED-1 Feature not
// on trunk yet.
pub(crate) fn authorize_manage(
    principal: &Principal,
    domain: Option<ReasonDomain>,
) -> Result<(), KernelError> {
    let Some(domain) = domain else {
        return Err(KernelError::forbidden("reason code stats are not enabled"));
    };
    let facts = Facts::new().bool("domain_tenant_extensible", domain.tenant_extensible());
    let resource = AuthorizationResource::org_wide(principal.org_id, "reason_code");
    enforce_action(principal, Feature::ReasonCodeManage, resource, &facts)
}

#[derive(Debug, Deserialize)]
struct CatalogQuery {
    domain: Option<String>,
}

async fn catalog(
    State(state): State<SettingsRestState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<CatalogQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let domain =
        parse_domain(query.domain.as_deref().unwrap_or_default()).map_err(KernelError::from)?;
    let items = state.store.reason_catalog(principal.org_id, domain).await?;
    Ok(Json(
        serde_json::json!({ "domain": domain, "items": items }),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AddRequest {
    domain: String,
    label_ko: String,
    #[serde(default)]
    label_en: Option<String>,
    requires_note: bool,
    #[serde(default)]
    involuntary: bool,
    #[serde(default)]
    notice_required: bool,
    #[serde(default)]
    sort: Option<i32>,
}

async fn add(
    State(state): State<SettingsRestState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<AddRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let audit = current_audit_context()
        .ok_or_else(|| KernelError::internal("request audit context is missing"))?;
    let cmd = AddReasonCode {
        domain: body.domain,
        label_ko: body.label_ko,
        label_en: body.label_en,
        requires_note: body.requires_note,
        involuntary: body.involuntary,
        notice_required: body.notice_required,
        sort: body.sort,
    };
    let view = state
        .store
        .add_reason_code(
            actor(&principal),
            cmd,
            (audit.trace, audit.request),
            move |d| authorize_manage(&principal, Some(d)),
        )
        .await?;
    Ok((StatusCode::CREATED, Json(view)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateRequest {
    #[serde(default)]
    active: Option<bool>,
    #[serde(default)]
    sort: Option<i32>,
}

async fn update(
    State(state): State<SettingsRestState>,
    Extension(principal): Extension<Principal>,
    Path((domain, code)): Path<(String, String)>,
    Json(body): Json<UpdateRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let audit = current_audit_context()
        .ok_or_else(|| KernelError::internal("request audit context is missing"))?;
    let cmd = UpdateReasonCode {
        domain,
        code,
        active: body.active,
        sort: body.sort,
    };
    let view = state
        .store
        .update_reason_code(
            actor(&principal),
            cmd,
            (audit.trace, audit.request),
            move |d| authorize_manage(&principal, Some(d)),
        )
        .await?;
    Ok(Json(view))
}

async fn stats(
    State(state): State<SettingsRestState>,
    Extension(principal): Extension<Principal>,
) -> Result<impl IntoResponse, ApiError> {
    authorize_manage(&principal, None)?;
    let items = state.store.reason_stats(principal.org_id).await?;
    Ok(Json(serde_json::json!({ "items": items })))
}

const fn actor(principal: &Principal) -> Actor {
    Actor {
        org: principal.org_id,
        user: principal.user_id,
    }
}
