//! BE-LC REST surface: period locks (freeze windows) + the generic object
//! lifecycle engine.
//!
//! Period locks are the enforcement substrate for UI-M7 month-close and UI-M8
//! 마감: locking `(domain, period)` makes every date-stamping payroll/financial
//! write inside the window fail closed (the guard lives in
//! `console_platform_db::period_lock` and is called from the domain write paths).
//! Lock/unlock/list are authority-gated (`Feature::PeriodLockManage`,
//! org-wide) and audited, following how the payroll admin endpoints gate.
//!
//! The lifecycle endpoints drive `console_platform_db::lifecycle`: a validated
//! per-object-type FSM (seeded `document` chain), an append-only transition
//! log, and legal-hold/retention dispose gates.

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_auth::{JwtVerifier, PasskeyService};
use console_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use console_platform_db::{lifecycle as lifecycle_db, with_audit, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

pub use error::LifecycleError;

pub const PERIOD_LOCKS_PATH: &str = "/api/v1/period-locks";
pub const PERIOD_LOCK_UNLOCK_PATH_TEMPLATE: &str = "/api/v1/period-locks/{lockId}/unlock";
pub const PERIOD_LOCK_UNLOCK_APPROVE_PATH_TEMPLATE: &str =
    "/api/v1/period-locks/{lockId}/unlock/approve";
pub const PERIOD_LOCK_UNLOCK_REJECT_PATH_TEMPLATE: &str =
    "/api/v1/period-locks/{lockId}/unlock/reject";
pub const LIFECYCLE_PATH_TEMPLATE: &str = "/api/v1/lifecycles/{objectType}/{objectId}";
pub const LIFECYCLE_TRANSITION_PATH_TEMPLATE: &str =
    "/api/v1/lifecycles/{objectType}/{objectId}/transition";
pub const LIFECYCLE_HOLD_PATH_TEMPLATE: &str = "/api/v1/lifecycles/{objectType}/{objectId}/hold";

pub const LIFECYCLE_ROUTE_PATHS: &[&str] = &[
    PERIOD_LOCKS_PATH,
    PERIOD_LOCK_UNLOCK_PATH_TEMPLATE,
    PERIOD_LOCK_UNLOCK_APPROVE_PATH_TEMPLATE,
    PERIOD_LOCK_UNLOCK_REJECT_PATH_TEMPLATE,
    LIFECYCLE_PATH_TEMPLATE,
    LIFECYCLE_TRANSITION_PATH_TEMPLATE,
    LIFECYCLE_HOLD_PATH_TEMPLATE,
];

#[derive(Clone)]
pub struct LifecycleState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
    /// Verifies the PERIOD_UNLOCK step-up; `None` ⇒ unlock answers 503.
    passkey_step_up: Option<PasskeyService>,
}

impl LifecycleState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            pool,
            jwt_verifier,
            passkey_step_up: None,
        }
    }
}

pub fn router(state: LifecycleState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(
            PERIOD_LOCKS_PATH,
            get(list_period_locks).post(create_period_lock),
        )
        .route(PERIOD_LOCK_UNLOCK_PATH_TEMPLATE, post(unlock_period_lock))
        .route(
            PERIOD_LOCK_UNLOCK_APPROVE_PATH_TEMPLATE,
            post(approve_period_unlock),
        )
        .route(
            PERIOD_LOCK_UNLOCK_REJECT_PATH_TEMPLATE,
            post(reject_period_unlock),
        )
        .route(LIFECYCLE_PATH_TEMPLATE, get(get_lifecycle))
        .route(
            LIFECYCLE_TRANSITION_PATH_TEMPLATE,
            post(transition_lifecycle),
        )
        .route(LIFECYCLE_HOLD_PATH_TEMPLATE, post(set_lifecycle_hold))
        .with_state(state);
    console_platform_request_context::with_request_context(router, verifier, pool)
}

mod error;
mod period_lock_view;
mod period_locks;
pub(crate) mod period_relock;
mod period_unlock;
mod sole_holder_unlock;
mod unlock_decision;
mod unlock_handlers;
use period_locks::{create_period_lock, list_period_locks};
use unlock_decision::reject_period_unlock;
use unlock_handlers::{approve_period_unlock, unlock_period_lock};

fn parse_iso_date(raw: &str, field: &str) -> Result<Date, LifecycleError> {
    Date::parse(raw, &time::format_description::well_known::Iso8601::DATE).map_err(|_| {
        LifecycleError::validation(format!("{field} must be an ISO date (YYYY-MM-DD)"))
    })
}

// ===========================================================================
// Object lifecycles.
// ===========================================================================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleTransitionResponse {
    from_state: String,
    to_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    actor: Option<Uuid>,
    reason: String,
    #[serde(with = "time::serde::rfc3339")]
    occurred_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleResponse {
    object_type: String,
    object_id: Uuid,
    current_state: String,
    legal_hold: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    retention_until: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
    transitions: Vec<LifecycleTransitionResponse>,
}

fn lifecycle_response(
    record: lifecycle_db::LifecycleRecord,
    transitions: Vec<lifecycle_db::LifecycleTransitionRecord>,
) -> LifecycleResponse {
    LifecycleResponse {
        object_type: record.object_type,
        object_id: record.object_id,
        current_state: record.current_state,
        legal_hold: record.legal_hold,
        retention_until: record.retention_until.map(|d| d.to_string()),
        created_at: record.created_at,
        updated_at: record.updated_at,
        transitions: transitions
            .into_iter()
            .map(|t| LifecycleTransitionResponse {
                from_state: t.from_state,
                to_state: t.to_state,
                actor: t.actor,
                reason: t.reason,
                occurred_at: t.occurred_at,
            })
            .collect(),
    }
}

fn validate_object_type(raw: &str) -> Result<(), LifecycleError> {
    let valid = (2..=64).contains(&raw.len())
        && raw.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && raw
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if valid {
        Ok(())
    } else {
        Err(LifecycleError::validation(
            "objectType must be a lowercase snake_case slug",
        ))
    }
}

async fn get_lifecycle(
    State(state): State<LifecycleState>,
    Extension(principal): Extension<Principal>,
    Path((object_type, object_id)): Path<(String, Uuid)>,
) -> Result<Json<LifecycleResponse>, LifecycleError> {
    authorize_lifecycle_manage(&principal)?;
    validate_object_type(&object_type)?;
    let org = principal.org_id;

    let response = with_org_conn::<_, _, LifecycleError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let record = lifecycle_db::get_lifecycle(tx, &object_type, object_id)
                .await?
                .ok_or_else(|| {
                    LifecycleError::from_kernel(KernelError::not_found(
                        "object has no lifecycle record",
                    ))
                })?;
            let transitions = lifecycle_db::list_transitions(tx, record.id).await?;
            Ok(lifecycle_response(record, transitions))
        })
    })
    .await?;
    Ok(Json(response))
}

async fn transition_lifecycle(
    State(state): State<LifecycleState>,
    Extension(principal): Extension<Principal>,
    Path((object_type, object_id)): Path<(String, Uuid)>,
    Json(body): Json<TransitionLifecycleRequest>,
) -> Result<Json<LifecycleResponse>, LifecycleError> {
    authorize_lifecycle_manage(&principal)?;
    validate_object_type(&object_type)?;
    let to_state = body.to_state.trim().to_owned();
    let reason = body.reason.trim().to_owned();
    let org = principal.org_id;
    let actor = principal.user_id;
    let now = OffsetDateTime::now_utc();

    let audit_event = AuditEvent::new(
        Some(actor),
        AuditAction::new("lifecycle.transition")?,
        "object_lifecycle",
        format!("{object_type}:{object_id}"),
        TraceContext::generate(),
        now,
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "object_type": object_type,
            "object_id": object_id,
            "to_state": to_state,
            "reason": reason,
        })),
    );

    let response = with_audit::<_, _, LifecycleError>(&state.pool, audit_event, move |tx| {
        Box::pin(async move {
            let record = lifecycle_db::transition_lifecycle(
                tx,
                *org.as_uuid(),
                &object_type,
                object_id,
                &to_state,
                Some(*actor.as_uuid()),
                &reason,
                now.date(),
            )
            .await
            .map_err(LifecycleError::from_kernel)?;
            let transitions = lifecycle_db::list_transitions(tx, record.id).await?;
            Ok(lifecycle_response(record, transitions))
        })
    })
    .await?;
    Ok(Json(response))
}

async fn set_lifecycle_hold(
    State(state): State<LifecycleState>,
    Extension(principal): Extension<Principal>,
    Path((object_type, object_id)): Path<(String, Uuid)>,
    Json(body): Json<SetLifecycleHoldRequest>,
) -> Result<Json<LifecycleResponse>, LifecycleError> {
    authorize_lifecycle_manage(&principal)?;
    validate_object_type(&object_type)?;
    let retention_until = body
        .retention_until
        .as_deref()
        .map(|raw| parse_iso_date(raw, "retentionUntil"))
        .transpose()?;
    let legal_hold = body.legal_hold;
    let org = principal.org_id;
    let actor = principal.user_id;

    let audit_event = AuditEvent::new(
        Some(actor),
        AuditAction::new("lifecycle.hold_set")?,
        "object_lifecycle",
        format!("{object_type}:{object_id}"),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "object_type": object_type,
            "object_id": object_id,
            "legal_hold": legal_hold,
            "retention_until": retention_until.map(|d| d.to_string()),
        })),
    );

    let response = with_audit::<_, _, LifecycleError>(&state.pool, audit_event, move |tx| {
        Box::pin(async move {
            let record = lifecycle_db::set_lifecycle_hold(
                tx,
                *org.as_uuid(),
                &object_type,
                object_id,
                legal_hold,
                retention_until,
            )
            .await
            .map_err(LifecycleError::from_kernel)?;
            let transitions = lifecycle_db::list_transitions(tx, record.id).await?;
            Ok(lifecycle_response(record, transitions))
        })
    })
    .await?;
    Ok(Json(response))
}

// ===========================================================================
// Authorization + error surface.
// ===========================================================================

fn authorize_lifecycle_manage(principal: &Principal) -> Result<(), LifecycleError> {
    authorize_org_wide(principal, Action::new(Feature::LifecycleManage))
        .map_err(LifecycleError::from_kernel)
}

#[cfg(test)]
#[path = "lifecycle_unknown_fields.rs"]
mod unknown_fields_tests;

#[path = "lifecycle_bodies.rs"]
mod lifecycle_bodies;
use lifecycle_bodies::*;
