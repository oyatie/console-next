//! BW-15 unlock and approve handlers; the rules are in [`super::period_unlock`].

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::{Extension, Json};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key,
};
use console_platform_db::period_lock::{
    NewUnlockRequest, UnlockWrite, approve_unlock_request_in_tx, load_lock_for_update,
    open_unlock_request_in_tx, unlock_in_tx,
};
use console_platform_db::with_audits;
use console_settings_adapter_postgres::{resolve_in_tx, validate_reason_in_tx};
use console_settings_domain::code_lists::ReasonDomain;
use console_settings_domain::{SettingKey, SettingValue};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::error::{idempotency_key_reused, optional_idempotency_key};
use super::period_lock_view::load_period_lock;
use super::period_locks::authorize_period_lock_manage;
use super::period_unlock::{
    ApprovePeriodUnlockRequest, SETTING_KEYS, UnlockPath, UnlockPeriodLockRequest, approve_payload,
    binding, coded, int_setting, request_json, second_person, unlock_admitted, unlock_event,
    unlock_path, unlock_payload, verify_step_up,
};
use super::sole_holder_unlock::{SoleHolderUnlock, record_sole_holder_exception};
use super::unlock_decision::{decider_stands, open_request};
use super::{LifecycleError, LifecycleState};

const UNLOCK_OPERATION: &str = "period_lock.unlock";
const APPROVE_OPERATION: &str = "period_lock.unlock_approve";

// console-gate: state-changing-handler
pub(super) async fn unlock_period_lock(
    State(state): State<LifecycleState>,
    Extension(principal): Extension<Principal>,
    Path(lock_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<UnlockPeriodLockRequest>,
) -> Result<(StatusCode, Json<Value>), LifecycleError> {
    authorize_period_lock_manage(&principal)?;
    let relock_at = OffsetDateTime::parse(body.relock_at.trim(), &Rfc3339)
        .map_err(|_| LifecycleError::validation("relockAt must be an RFC 3339 timestamp"))?;
    let idempotency_key = optional_idempotency_key(&headers)?;
    let fingerprint = json!({
        "lock_id": lock_id, "reason_code": &body.reason_code,
        "note": &body.note, "relock_at": &body.relock_at,
    });
    let org = principal.org_id;
    let user = *principal.user_id.as_uuid();
    let verifier = state.passkey_step_up.clone();

    let (status, response) = with_audits::<_, _, LifecycleError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            if let Some(key) = &idempotency_key {
                match claim_idempotency_key(tx, UNLOCK_OPERATION, key, &fingerprint).await? {
                    IdempotencyClaim::Replay(stored) => return Ok(((StatusCode::OK, stored), vec![])),
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
            }
            let reason = validate_reason_in_tx(
                tx.as_mut(), org, ReasonDomain::PeriodUnlock, body.reason_code.trim(),
                body.note.as_deref(),
            )
            .await?;
            let now = OffsetDateTime::now_utc();
            let settings = resolve_in_tx(tx.as_mut(), org, &SETTING_KEYS, None, now).await?;
            let max_days = int_setting(&settings, SettingKey::PeriodLockUnlockMaxDays)?;
            if relock_at <= now || relock_at > now + Duration::days(max_days) {
                return Err(LifecycleError::from_kernel(
                    KernelError::validation(format!(
                        "relockAt must be in the future and at most {max_days} days out"
                    ))
                    .with_code("period_unlock_window_invalid"),
                ));
            }
            load_lock_for_update(tx, lock_id)
                .await?
                .ok_or_else(|| LifecycleError::from_kernel(KernelError::not_found("period lock was not found")))?;
            let fact = second_person(tx, org, user, now, &settings).await?;
            // Fail closed: anything but the documented loosening reads as refuse.
            let sole_holder_refuse = !matches!(
                settings.get(&SettingKey::AuthzSoleHolderMode),
                Some(Ok(resolved)) if matches!(resolved.value, SettingValue::Code("step_up_notice_review"))
            );
            // Admission is a separate Cedar decision; no assertion has been verified yet.
            if !unlock_admitted(&user.to_string(), &org.to_string(), fact.other_eligible_holders, sole_holder_refuse) {
                return Err(coded(
                    StatusCode::CONFLICT,
                    "period_unlock_sole_holder_refused",
                    "no second person can approve this unlock and the sole-holder mode refuses it",
                ));
            }
            let payload = unlock_payload(lock_id, &reason.code, &body.relock_at);
            let step_up =
                verify_step_up(verifier.as_ref(), tx, body.step_up, user, &binding(lock_id, &payload)).await?;
            // This fact is true only after verify_step_up returned a bound assertion.
            let path = unlock_path(&user.to_string(), &org.to_string(), fact.other_eligible_holders, sole_holder_refuse, true);
            if path == UnlockPath::Refused {
                return Err(coded(StatusCode::CONFLICT, "period_unlock_sole_holder_refused", "기간 잠금 해제가 허용되지 않았습니다"));
            }
            let (status, outcome, event) = if path == UnlockPath::SecondPerson {
                    let (request, superseded) = open_unlock_request_in_tx(tx, &NewUnlockRequest {
                        org_id: *org.as_uuid(), lock_id, requested_by: user,
                        reason_code: &reason.code, reason_note: reason.note.as_deref(),
                        relock_at, step_up_assertion_id: step_up,
                    })
                    .await?;
                    let event = unlock_event(user, org, "period_lock.unlock_request", lock_id, json!({
                        "request_id": request.id, "superseded_request_id": superseded,
                        "reason_code": &request.reason_code, "relock_at": body.relock_at,
                        "step_up_assertion_id": step_up,
                        "other_eligible_holders": fact.other_eligible_holders,
                    }))?;
                    let lock = load_period_lock(tx, lock_id).await?;
                    (StatusCode::ACCEPTED, json!({
                        "status": "PENDING_SECOND_PERSON", "lock": lock, "request": request_json(&request),
                    }), event)
            } else {
                    let unlocked = unlock_in_tx(tx, lock_id, &UnlockWrite {
                        unlocked_by: user, approved_by: None, step_up_assertion_id: step_up,
                        reason_code: &reason.code, note: reason.note.as_deref(), relock_at,
                        review_required: true,
                    })
                    .await?;
                    let exception = record_sole_holder_exception(tx, &SoleHolderUnlock {
                        unlocked, actor: user, reason_code: &reason.code,
                        note: reason.note.as_deref(), relock_at: &body.relock_at, step_up,
                    }, &settings).await?;
                    let review_due_at = exception.review_due_at.and_then(|at| at.format(&Rfc3339).ok());
                    let lock = load_period_lock(tx, unlocked).await?;
                    let flags: Vec<_> = fact.review_flags.iter().filter_map(|f| f.reason.clone()).collect();
                    let event = unlock_event(user, org, "period_lock.unlock", unlocked, json!({
                        "domain": &lock.domain, "period_start": &lock.period_start,
                        "period_end": &lock.period_end, "unlock_reason_code": &reason.code,
                        "relock_at": body.relock_at, "step_up_assertion_id": step_up,
                        "sole_holder": true, "review_required": true, "review_flags": flags,
                        "exception_id": exception.id, "review_due_at": &review_due_at,
                    }))?;
                    (StatusCode::OK, json!({
                        "status": "UNLOCKED", "lock": lock,
                        "exception": { "id": exception.id, "reviewDueAt": review_due_at },
                    }), event)
            };
            if let Some(key) = &idempotency_key {
                complete_idempotency_key(tx, UNLOCK_OPERATION, key, &outcome).await?;
            }
            Ok(((status, outcome), vec![event]))
        })
    })
    .await?;
    Ok((status, Json(response)))
}

// console-gate: state-changing-handler
pub(super) async fn approve_period_unlock(
    State(state): State<LifecycleState>,
    Extension(principal): Extension<Principal>,
    Path(lock_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<ApprovePeriodUnlockRequest>,
) -> Result<Json<Value>, LifecycleError> {
    authorize_period_lock_manage(&principal)?;
    let idempotency_key = optional_idempotency_key(&headers)?;
    let request_id = body.request_id;
    let fingerprint = json!({ "lock_id": lock_id, "request_id": request_id });
    let org = principal.org_id;
    let approver = *principal.user_id.as_uuid();
    let verifier = state.passkey_step_up.clone();

    let response = with_audits::<_, _, LifecycleError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            if let Some(key) = &idempotency_key {
                match claim_idempotency_key(tx, APPROVE_OPERATION, key, &fingerprint).await? {
                    IdempotencyClaim::Replay(stored) => return Ok((stored, vec![])),
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
            }
            let now = OffsetDateTime::now_utc();
            let request = open_request(tx, lock_id, request_id, now).await?;
            let settings = resolve_in_tx(tx.as_mut(), org, &SETTING_KEYS, None, now).await?;
            let stands = decider_stands(tx, &principal, &request, &settings).await?;
            let break_glass = stands == "ops_break_glass";
            let step_up = verify_step_up(
                verifier.as_ref(),
                tx,
                body.step_up,
                approver,
                &binding(request.id, &approve_payload(request.id)),
            )
            .await?;
            let unlocked = unlock_in_tx(
                tx,
                lock_id,
                &UnlockWrite {
                    unlocked_by: request.requested_by,
                    approved_by: Some(approver),
                    step_up_assertion_id: step_up,
                    reason_code: &request.reason_code,
                    note: request.reason_note.as_deref(),
                    relock_at: request.relock_at,
                    review_required: break_glass,
                },
            )
            .await?;
            approve_unlock_request_in_tx(tx, request.id, approver).await?;
            let lock = load_period_lock(tx, unlocked).await?;
            let event = unlock_event(
                approver,
                org,
                "period_lock.unlock",
                unlocked,
                json!({
                    "domain": &lock.domain, "period_start": &lock.period_start,
                    "period_end": &lock.period_end, "request_id": request.id,
                    "unlocked_by": request.requested_by, "unlock_approved_by": approver,
                    "unlock_reason_code": &request.reason_code, "step_up_assertion_id": step_up,
                    "second_person": stands, "review_required": break_glass,
                }),
            )?;
            let outcome = json!({ "status": "UNLOCKED", "lock": lock });
            if let Some(key) = &idempotency_key {
                complete_idempotency_key(tx, APPROVE_OPERATION, key, &outcome).await?;
            }
            Ok((outcome, vec![event]))
        })
    })
    .await?;
    Ok(Json(response))
}
