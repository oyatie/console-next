//! BW-15 second-person decision on a waiting unlock: who may decide it (shared
//! by approve, reject and the lock list's `canDecide`), and the refusal (반려).
//!
//! Cedar `period_unlock_decide` decides: another person than the requester
//! (the `independent_people` bindings) who is an eligible second person
//! (identity's D0.2 fact), or the tenant ops account as break-glass
//! (decisions #26 item d, flagged for review on approve).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::{Extension, Json};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use console_platform_authz::cedar_pbac::actions::independent_people;
use console_platform_authz::cedar_pbac::actions::period_unlock_decide::{self, DecideFacts};
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
};
use console_platform_db::period_lock::{
    UnlockRequest, load_open_unlock_request_for_update, reject_unlock_request_in_tx,
};
use console_platform_db::with_audits;
use console_settings_adapter_postgres::{ResolvedSettings, resolve_in_tx};
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use super::error::{idempotency_key_reused, optional_idempotency_key};
use super::period_lock_view::load_period_lock;
use super::period_locks::authorize_period_lock_manage;
use super::period_unlock::{SETTING_KEYS, coded, second_person, unlock_event};
use super::{LifecycleError, LifecycleState};

const REJECT_OPERATION: &str = "period_lock.unlock_reject";
const NOTE_MAX: usize = 1000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RejectPeriodUnlockRequest {
    pub(super) request_id: Uuid,
    pub(super) note: String,
}

/// How the caller stands as the second person of `request`: `"eligible"` or
/// `"ops_break_glass"`; refused (403) for the requester's own person or anyone
/// else not eligible.
pub(super) async fn decider_stands(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    request: &UnlockRequest,
    settings: &ResolvedSettings,
) -> Result<&'static str, LifecycleError> {
    let me = *principal.user_id.as_uuid();
    let independent =
        independent_people::authorized_in_tx(tx, Some(request.requested_by), me).await?;
    let fact = second_person(
        tx,
        principal.org_id,
        request.requested_by,
        request.requested_at,
        settings,
    )
    .await?;
    let facts = DecideFacts {
        independent,
        eligible: fact.eligible.contains(&me),
        ops: principal.is_tenant_ops,
    };
    let org = principal.org_id.as_uuid().to_string();
    // The request was read under the transaction's armed tenant (RLS).
    let armed: Option<String> =
        sqlx::query_scalar("SELECT NULLIF(current_setting('app.current_org', true), '')")
            .fetch_one(tx.as_mut())
            .await?;
    let lock_org = armed.unwrap_or_default();
    if period_unlock_decide::decide(&me.to_string(), &org, &lock_org, facts) {
        return Ok(if facts.eligible {
            "eligible"
        } else {
            "ops_break_glass"
        });
    }
    Err(if independent {
        coded(
            StatusCode::FORBIDDEN,
            "second_person_ineligible",
            "you are not an eligible second person for this unlock",
        )
    } else {
        coded(
            StatusCode::FORBIDDEN,
            "second_person_required",
            "the requester cannot decide their own unlock",
        )
    })
}

/// The lock's open request, locked, still the one the caller saw (409 when a
/// newer request replaced it) and still inside its window (409 once expired).
pub(super) async fn open_request(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    lock_id: Uuid,
    seen: Option<Uuid>,
    now: OffsetDateTime,
) -> Result<UnlockRequest, LifecycleError> {
    let request = load_open_unlock_request_for_update(tx, lock_id)
        .await?
        .ok_or_else(|| {
            LifecycleError::from_kernel(KernelError::not_found(
                "no unlock request is waiting for approval on this lock",
            ))
        })?;
    if seen.is_some_and(|id| id != request.id) {
        return Err(coded(
            StatusCode::CONFLICT,
            "period_unlock_request_changed",
            "a newer unlock request replaced the one you reviewed; review the current request",
        ));
    }
    if request.relock_at <= now {
        return Err(coded(
            StatusCode::CONFLICT,
            "period_unlock_request_expired",
            "the requested unlock window has already ended; request the unlock again",
        ));
    }
    Ok(request)
}

fn decision_note(raw: &str) -> Result<String, LifecycleError> {
    let note = raw.trim();
    if note.is_empty() || note.chars().count() > NOTE_MAX {
        return Err(LifecycleError::from_kernel(
            KernelError::validation(format!("note must be 1 to {NOTE_MAX} characters"))
                .with_code("period_unlock_reject_note_invalid"),
        ));
    }
    Ok(note.to_owned())
}

// console-gate: state-changing-handler
pub(super) async fn reject_period_unlock(
    State(state): State<LifecycleState>,
    Extension(principal): Extension<Principal>,
    Path(lock_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<RejectPeriodUnlockRequest>,
) -> Result<Json<Value>, LifecycleError> {
    authorize_period_lock_manage(&principal)?;
    let note = decision_note(&body.note)?;
    let idempotency_key = optional_idempotency_key(&headers)?;
    let fingerprint = json!({ "lock_id": lock_id, "request_id": body.request_id, "note": &note });
    let org = principal.org_id;
    let decider = *principal.user_id.as_uuid();

    let response = with_audits::<_, _, LifecycleError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            if let Some(key) = &idempotency_key {
                match claim_idempotency_key(tx, REJECT_OPERATION, key, &fingerprint).await? {
                    IdempotencyClaim::Replay(stored) => return Ok((stored, vec![])),
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
            }
            let now = OffsetDateTime::now_utc();
            let request = open_request(tx, lock_id, Some(body.request_id), now).await?;
            let settings = resolve_in_tx(tx.as_mut(), org, &SETTING_KEYS, None, now).await?;
            let stands = decider_stands(tx, &principal, &request, &settings).await?;
            reject_unlock_request_in_tx(tx, request.id, decider, &note).await?;
            let lock = load_period_lock(tx, lock_id).await?;
            let event = unlock_event(
                decider,
                org,
                "period_lock.unlock_reject",
                lock_id,
                json!({
                    "request_id": request.id, "requested_by": request.requested_by,
                    "unlock_reason_code": &request.reason_code, "second_person": stands,
                }),
            )?;
            let outcome = json!({ "status": "REJECTED", "lock": lock });
            if let Some(key) = &idempotency_key {
                complete_idempotency_key(tx, REJECT_OPERATION, key, &outcome).await?;
            }
            Ok((outcome, vec![event]))
        })
    })
    .await?;
    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::{RejectPeriodUnlockRequest, decision_note};

    #[test]
    fn a_refusal_needs_a_note_within_the_bound() {
        assert_eq!(
            decision_note("  다음 달에 다시 요청  ").unwrap(),
            "다음 달에 다시 요청"
        );
        assert_eq!(
            decision_note(&"가".repeat(1000)).unwrap().chars().count(),
            1000
        );
        for bad in ["", "   ", &"가".repeat(1001)] {
            assert_eq!(
                decision_note(bad).unwrap_err().code,
                "period_unlock_reject_note_invalid"
            );
        }
    }

    #[test]
    fn unknown_fields_reject_period_unlock_request() {
        console_platform_test_support::strict_json::rejects_unknown_with::<RejectPeriodUnlockRequest>(
            serde_json::json!({ "requestId": uuid::Uuid::nil(), "note": "반려" }),
        );
    }
}
