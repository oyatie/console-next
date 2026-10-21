//! Settings registry REST surface (BW-00).
//!
//! - `GET  /api/v1/settings[?entity=]`: every key resolved now, with its
//!   definition and scheduled rows. Any signed-in member: the frontend reads
//!   these values, it never decides with them (ADR-006).
//! - `GET  /api/v1/settings/{key}/history`: stored rows (carry `set_by` and
//!   `reason_note`, personal data).
//! - `POST /api/v1/settings/{key}`: change one key.
//! - `/api/v1/reason-codes/**`: the reason-code catalog (BW-07).
//!
//! `router(state)` self-applies `with_request_context`; INTEG wires it into
//! the app (INT-6a) and registers `SETTINGS_ROUTE_PATHS` and
//! `REASON_CODES_ROUTE_PATHS`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod openapi;
pub use openapi::OPENAPI_FRAGMENT;

mod error;
mod reason_codes;

pub use reason_codes::REASON_CODES_ROUTE_PATHS;

use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use console_kernel_core::{KernelError, Timestamp};
use console_platform_auth::JwtVerifier;
use console_platform_authz::cedar_pbac::enforce::enforce_action;
use console_platform_authz::cedar_pbac::facts::Facts;
use console_platform_authz::{AuthorizationResource, Feature, Principal};
use console_platform_request_context::current_audit_context;
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_application::{Actor, ChangeFacts, ChangeSetting};
use console_settings_domain::Direction;
use console_settings_domain::SettingKey;
use error::ApiError;
use serde::Deserialize;
use uuid::Uuid;

pub const SETTINGS_PATH: &str = "/api/v1/settings";
pub const SETTING_PATH: &str = "/api/v1/settings/{key}";
pub const SETTING_HISTORY_PATH: &str = "/api/v1/settings/{key}/history";

pub const SETTINGS_ROUTE_PATHS: &[&str] = &[SETTINGS_PATH, SETTING_PATH, SETTING_HISTORY_PATH];

#[derive(Clone)]
pub struct SettingsRestState {
    store: PgSettingsStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl SettingsRestState {
    #[must_use]
    pub const fn new(store: PgSettingsStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: SettingsRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(SETTINGS_PATH, get(list))
        .route(SETTING_PATH, post(change))
        .route(SETTING_HISTORY_PATH, get(history))
        .merge(reason_codes::routes())
        .with_state(state);
    console_platform_request_context::with_request_context(router, verifier, pool)
}

/// Who may change a setting is Cedar's (`settings_manage`, with the change
/// direction and step-up as facts; a loosening needs a fresh step-up, D0.3).
/// Denies until F-CEDAR enrols the `settings_manage` schema (GOV-CED-1),
/// which must declare exactly these facts.
fn authorize_change(principal: &Principal, facts: &ChangeFacts) -> Result<(), KernelError> {
    let direction = match facts.direction {
        Direction::Tighten => "tighten",
        Direction::Loosen => "loosen",
        Direction::Neutral => "neutral",
    };
    let facts = Facts::new()
        .string("direction", direction)
        .bool("step_up", facts.step_up_assertion_id.is_some());
    let resource = AuthorizationResource::org_wide(principal.org_id, "setting");
    enforce_action(principal, Feature::SettingsManage, resource, &facts)
}

/// History shows who changed what and why: settings administrators only.
// deny-all (fail closed). Reading history is `policy_config_view`
// (governance design §2.2), a GOV-CED-1 Feature not on trunk yet; swap this
// body for `enforce_action(.., Feature::PolicyConfigView, ..)` when it lands.
fn authorize_history(_principal: &Principal) -> Result<(), KernelError> {
    Err(KernelError::forbidden("settings history is not enabled"))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    entity: Option<Uuid>,
}

async fn list(
    State(state): State<SettingsRestState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ListQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let items = state
        .store
        .list_effective(principal.org_id, query.entity)
        .await?;
    Ok(Json(serde_json::json!({ "items": items })))
}

async fn history(
    State(state): State<SettingsRestState>,
    Extension(principal): Extension<Principal>,
    Path(key): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    authorize_history(&principal)?;
    let key = parse_key(&key)?;
    let items = state.store.history(principal.org_id, key).await?;
    Ok(Json(serde_json::json!({ "items": items })))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangeRequest {
    value: serde_json::Value,
    #[serde(default, with = "time::serde::rfc3339::option")]
    effective_from: Option<Timestamp>,
    #[serde(default)]
    scope_entity_id: Option<Uuid>,
    reason_code: String,
    #[serde(default)]
    reason_note: Option<String>,
    #[serde(default)]
    step_up_assertion_id: Option<Uuid>,
}

async fn change(
    State(state): State<SettingsRestState>,
    Extension(principal): Extension<Principal>,
    Path(key): Path<String>,
    Json(body): Json<ChangeRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let audit = current_audit_context()
        .ok_or_else(|| KernelError::internal("request audit context is missing"))?;
    let actor = Actor {
        org: principal.org_id,
        user: principal.user_id,
    };
    let cmd = ChangeSetting {
        key,
        scope_entity_id: body.scope_entity_id,
        value: body.value,
        effective_from: body.effective_from,
        reason_code: body.reason_code,
        reason_note: body.reason_note,
        step_up_assertion_id: body.step_up_assertion_id,
    };
    let view = state
        .store
        .change_setting(actor, cmd, (audit.trace, audit.request), move |facts| {
            authorize_change(&principal, facts)
        })
        .await?;
    Ok((StatusCode::CREATED, Json(view)))
}

fn parse_key(raw: &str) -> Result<SettingKey, ApiError> {
    raw.parse().map_err(|_| {
        ApiError::from(
            KernelError::not_found(format!("unknown setting key: {raw}"))
                .with_code("setting_unknown_key")
                .with_field("key"),
        )
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use console_kernel_core::{BranchScope, ErrorKind, OrgId, UserId};
    use console_platform_authz::Role;
    use console_settings_domain::SettingKey;

    use super::*;

    /// A plain member loosening without step-up is refused through the Cedar
    /// call, whether or not the schemas are enrolled yet (fail closed).
    #[test]
    fn a_member_is_refused_on_every_swapped_route() {
        let member = Principal::new(
            UserId::new(),
            OrgId::one(),
            BTreeSet::from([Role::Member]),
            BranchScope::All,
        );
        let change = ChangeFacts {
            key: SettingKey::ALL[0],
            direction: Direction::Loosen,
            step_up_assertion_id: None,
        };
        let domain = console_settings_domain::code_lists::ReasonDomain::ALL[0];
        for got in [
            authorize_change(&member, &change),
            authorize_history(&member),
            reason_codes::authorize_manage(&member, Some(domain)),
            reason_codes::authorize_manage(&member, None),
        ] {
            assert_eq!(got.unwrap_err().kind, ErrorKind::Forbidden);
        }
    }
}
