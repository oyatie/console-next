//! Period locks (freeze windows): list, lock and unlock. Split out of
//! `lifecycle.rs` verbatim (LOCK lane, before BW-15).

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::{Extension, Json};
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_auth::PasskeyService;
use console_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
};
use console_platform_db::{PeriodLockDomain, lock_period_lock_key, with_audits, with_org_conn};
use console_settings_adapter_postgres::validate_reason_in_tx;
use console_settings_domain::code_lists::ReasonDomain;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::error::{idempotency_key_reused, optional_idempotency_key};
use super::period_lock_view::{
    PeriodLockListResponse, attach_unlock_requests, list_locks, load_period_lock,
};
use super::{LifecycleError, LifecycleState, parse_iso_date};

impl LifecycleState {
    /// Verifies the PERIOD_UNLOCK step-up; without it unlock answers 503.
    #[must_use]
    pub fn with_passkey_step_up(mut self, passkey_step_up: Option<PasskeyService>) -> Self {
        self.passkey_step_up = passkey_step_up;
        self
    }
}

const MAX_LIST_LIMIT: i64 = 200;
const MAX_REASON_CHARS: usize = 1000;

/// A lock/unlock reason: trimmed, non-blank, at most 1000 characters.
fn period_lock_reason(raw: &str) -> Result<String, LifecycleError> {
    let reason = raw.trim().to_owned();
    if reason.is_empty() {
        return Err(LifecycleError::validation("reason must not be blank"));
    }
    if reason.chars().count() > MAX_REASON_CHARS {
        return Err(LifecycleError::validation(
            "reason must be at most 1000 characters",
        ));
    }
    Ok(reason)
}
const DEFAULT_LIST_LIMIT: i64 = 50;

// ===========================================================================
// Period locks.
// ===========================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreatePeriodLockRequest {
    domain: String,
    period_start: String,
    period_end: String,
    /// The `period_lock` reason code (0252); the free text is then its note.
    #[serde(default)]
    reason_code: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PeriodLockListQuery {
    domain: Option<String>,
    limit: Option<i64>,
    /// `true`: only locks in force (`period_lock_effective`), for date inputs.
    active: Option<bool>,
}

pub(super) async fn list_period_locks(
    State(state): State<LifecycleState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<PeriodLockListQuery>,
) -> Result<Json<PeriodLockListResponse>, LifecycleError> {
    authorize_period_lock_manage(&principal)?;
    let domain = query
        .domain
        .as_deref()
        .map(PeriodLockDomain::parse)
        .transpose()?
        .map(PeriodLockDomain::as_str);
    let limit = query
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let active = query.active;
    let org = principal.org_id;

    let items = with_org_conn::<_, _, LifecycleError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let mut items = list_locks(tx, domain, limit, active).await?;
            attach_unlock_requests(tx, &principal, &mut items).await?;
            Ok(items)
        })
    })
    .await?;
    Ok(Json(PeriodLockListResponse { items }))
}

pub(super) async fn create_period_lock(
    State(state): State<LifecycleState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Json(body): Json<CreatePeriodLockRequest>,
) -> Result<(StatusCode, Json<Value>), LifecycleError> {
    authorize_period_lock_manage(&principal)?;
    let domain = PeriodLockDomain::parse(&body.domain)?;
    let period_start = parse_iso_date(&body.period_start, "periodStart")?;
    let period_end = parse_iso_date(&body.period_end, "periodEnd")?;
    if period_end < period_start {
        return Err(LifecycleError::validation(
            "periodEnd must not precede periodStart",
        ));
    }
    let reason_code = body
        .reason_code
        .as_deref()
        .map(str::trim)
        .map(str::to_owned);
    let reason = match (&reason_code, body.reason.as_deref()) {
        (Some(_), None) => None,
        (_, Some(raw)) => Some(period_lock_reason(raw)?),
        (None, None) => return Err(LifecycleError::validation("reason must not be blank")),
    };
    let idempotency_key = optional_idempotency_key(&headers)?;
    let fingerprint = json!({
        "domain": domain.as_str(),
        "period_start": period_start.to_string(),
        "period_end": period_end.to_string(),
        "reason_code": &reason_code,
        "reason": &reason,
    });

    let lock_id = Uuid::new_v4();
    let org = principal.org_id;
    let actor = principal.user_id;

    let (status, response) = with_audits::<_, _, LifecycleError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            if let Some(key) = &idempotency_key {
                match claim_idempotency_key(tx, LOCK_OPERATION, key, &fingerprint).await? {
                    IdempotencyClaim::Replay(stored) => return Ok(((StatusCode::OK, stored), vec![])),
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
            }
            let reason_code = match &reason_code {
                Some(code) => Some(
                    validate_reason_in_tx(tx.as_mut(), org, ReasonDomain::PeriodLock, code, reason.as_deref())
                        .await?
                        .code,
                ),
                None => None,
            };
            // Serialize the lock CREATE with the drain's gated staging write:
            // both take this per-org advisory lock, so a lock cannot commit
            // between the staging INSERT's snapshot and its commit.
            lock_period_lock_key(tx, domain, *org.as_uuid()).await?;
            // Refuse a duplicate active lock covering the same window: one
            // active lock per (domain, window) keeps unlock semantics obvious.
            let overlapping: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM period_locks \
                 WHERE domain = $1 AND period_lock_effective(period_locks) \
                   AND period_start <= $3 AND period_end >= $2",
            )
            .bind(domain.as_str())
            .bind(period_start)
            .bind(period_end)
            .fetch_one(tx.as_mut())
            .await?;
            if overlapping > 0 {
                return Err(LifecycleError::from_kernel(KernelError::conflict(format!(
                    "an active {domain} lock already overlaps {period_start}..{period_end}"
                ))));
            }

            sqlx::query(
                "INSERT INTO period_locks \
                     (id, org_id, domain, period_start, period_end, reason, reason_code, locked_by) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(lock_id)
            .bind(*org.as_uuid())
            .bind(domain.as_str())
            .bind(period_start)
            .bind(period_end)
            .bind(&reason)
            .bind(&reason_code)
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;
            let locked = serde_json::to_value(load_period_lock(tx, lock_id).await?)
                .map_err(|e| LifecycleError::from_kernel(KernelError::internal(e.to_string())))?;
            if let Some(key) = &idempotency_key {
                complete_idempotency_key(tx, LOCK_OPERATION, key, &locked).await?;
            }
            let audit_event = AuditEvent::new(
                Some(actor),
                AuditAction::new("period_lock.lock")?,
                "period_lock",
                lock_id.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org)
            .with_snapshots(
                None,
                Some(json!({
                    "domain": domain.as_str(),
                    "period_start": period_start.to_string(),
                    "period_end": period_end.to_string(),
                    "reason_code": &reason_code,
                    "reason": &reason,
                })),
            );
            Ok(((StatusCode::CREATED, locked), vec![audit_event]))
        })
    })
    .await?;
    Ok((status, Json(response)))
}

const LOCK_OPERATION: &str = "period_lock.lock";

pub(super) fn authorize_period_lock_manage(principal: &Principal) -> Result<(), LifecycleError> {
    authorize_org_wide(principal, Action::new(Feature::PeriodLockManage))
        .map_err(LifecycleError::from_kernel)
}
