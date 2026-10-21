// SPDX-License-Identifier: LicenseRef-Proprietary
//! Current holders, D0.2 eligibility and the payload-bound solo correction.

use std::collections::BTreeSet;

use console_identity_adapter_postgres::second_person::{
    HolderCapability, PgHolderResolver, SecondPersonQuery, second_person_fact_in_tx,
};
use console_identity_application::holders::HolderResolver;
use console_kernel_core::{BranchId, KernelError, UserId};
use console_platform_auth::{
    AuthError, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope,
    MobilePasskeyStepUpVerificationError, MobileStepUpActionKind, PasskeyService,
};
use console_platform_authz::Principal;
use console_platform_authz::cedar_pbac::actions::independent_people;
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::{SettingKey, SettingValue};
use http::StatusCode;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::correct::CorrectLifecycleEventRequest;
use crate::HrError;
use crate::authz::APPOINTMENT_KEYS;
use crate::corrections::{SecondPersonContext, refusal};
use crate::digest::sha256_hex;
use crate::exits::settlement::canonical_json;
use crate::requests::cedar::sole_holder_cedar;

/// EXCEPTION_DECIDE on the original event, signing the complete replacement.
#[must_use]
pub fn lifecycle_correction_binding(
    employee: Uuid,
    event: Uuid,
    request: &CorrectLifecycleEventRequest,
) -> MobilePasskeyStepUpBinding {
    let payload = json!({
        "operation": "employee.lifecycle.correct", "employee_id": employee,
        "replacement": request.replacement, "reason_code": request.reason_code.trim(),
        "note": request.note.as_deref().map(str::trim),
    });
    let kind = MobileStepUpActionKind::ExceptionDecide;
    MobilePasskeyStepUpBinding {
        action_kind: kind,
        object_id: event,
        reason_key: kind.expected_reason_key().to_owned(),
        replay_attempt: None,
        payload_hash: Some(sha256_hex(canonical_json(&payload).to_string().as_bytes())),
    }
}

pub(super) async fn authorize_sensitive_correction(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    employee: Uuid,
    event: Uuid,
    passkeys: Option<&PasskeyService>,
    envelope: Option<MobilePasskeyStepUpEnvelope>,
    binding: &MobilePasskeyStepUpBinding,
) -> Result<Option<Uuid>, HrError> {
    let required = || {
        refusal(
            StatusCode::FORBIDDEN,
            "second_person_required",
            "날짜를 바꾸는 정정은 다른 권한자가 기록해야 합니다",
        )
    };
    let (creator, created_at): (Uuid, OffsetDateTime) = sqlx::query_as(
        "SELECT created_by, created_at FROM employee_lifecycle_events WHERE org_id=$1 AND id=$2",
    )
    .bind(principal.org_id.as_uuid())
    .bind(event)
    .fetch_one(tx.as_mut())
    .await?;
    let branch: Option<Uuid> =
        sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE org_id=$1 AND id=$2")
            .bind(principal.org_id.as_uuid())
            .bind(employee)
            .fetch_one(tx.as_mut())
            .await?;
    let actor = *principal.user_id.as_uuid();
    let now = OffsetDateTime::now_utc();
    let mut live = BTreeSet::new();
    for feature in APPOINTMENT_KEYS {
        live.extend(
            PgHolderResolver {
                tx,
                org: principal.org_id,
                capability: HolderCapability::Feature {
                    feature,
                    branch: branch.map(BranchId::from_uuid),
                },
                exclude_account: None,
                exclude_employee: Some(employee),
                include_ops: true,
                now,
            }
            .resolve()
            .await
            .map_err(HrError::from_kernel)?,
        );
    }
    if !live.contains(&actor) {
        return Err(required());
    }
    if independent_people::authorized_in_tx(tx, Some(creator), actor).await? {
        return Ok(None);
    }
    let settings = resolve_in_tx(
        tx.as_mut(),
        principal.org_id,
        &[
            SettingKey::AuthzSoleHolderMode,
            SettingKey::AuthzSecondPersonMinGrantAge,
        ],
        None,
        now,
    )
    .await?;
    let min_grant_age_days = match settings.get(&SettingKey::AuthzSecondPersonMinGrantAge) {
        Some(Ok(s)) => match s.value {
            SettingValue::Int(days) => i32::try_from(days).ok(),
            _ => None,
        },
        _ => None,
    }
    .ok_or_else(|| {
        HrError::from_kernel(KernelError::internal(
            "authz.second_person.min_grant_age did not resolve",
        ))
    })?;
    let refuse = !matches!(settings.get(&SettingKey::AuthzSoleHolderMode), Some(Ok(s)) if matches!(s.value, SettingValue::Code("step_up_notice_review")));
    let excluded: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND employee_id=$2 FOR SHARE")
            .bind(principal.org_id.as_uuid())
            .bind(employee)
            .fetch_all(tx.as_mut())
            .await?;
    // Keep current holders and the demotion guard: removing a checker cannot manufacture a solo path.
    for feature in APPOINTMENT_KEYS {
        live.extend(
            second_person_fact_in_tx(
                tx,
                &SecondPersonQuery {
                    org: principal.org_id,
                    feature,
                    branch: branch.map(BranchId::from_uuid),
                    requester: principal.user_id,
                    excluded: excluded.iter().copied().map(UserId::from_uuid).collect(),
                    case_created_at: created_at,
                    min_grant_age_days,
                },
            )
            .await
            .map_err(HrError::from_kernel)?
            .eligible,
        );
    }
    let mut others = 0;
    for holder in live {
        if holder != actor && independent_people::authorized_in_tx(tx, Some(actor), holder).await? {
            others += 1;
        }
    }
    if refuse || others > 0 {
        return Err(required());
    }
    let envelope = envelope.ok_or_else(|| {
        refusal(
            StatusCode::UNAUTHORIZED,
            "step_up_required",
            "패스키로 본인 확인을 해 주십시오",
        )
    })?;
    let passkeys = passkeys.ok_or_else(|| {
        refusal(
            StatusCode::SERVICE_UNAVAILABLE,
            "step_up_unavailable",
            "패스키 본인 확인을 사용할 수 없습니다",
        )
    })?;
    let assertion = passkeys
        .verify_and_record_step_up_in_tx(tx, envelope, actor, binding)
        .await
        .map_err(step_up_error)?;
    sole_holder_cedar(
        principal,
        employee,
        SecondPersonContext {
            other_eligible_holders: others,
            sole_holder_refuse: refuse,
            routed: true,
        },
    )?;
    Ok(Some(assertion))
}

fn step_up_error(error: MobilePasskeyStepUpVerificationError) -> HrError {
    match error {
        MobilePasskeyStepUpVerificationError::Auth(AuthError::Sqlx(_) | AuthError::Db(_)) => {
            tracing::error!(%error, "lifecycle correction step-up failed on the server");
            HrError::from_kernel(KernelError::internal(
                "패스키 본인 확인을 완료하지 못했습니다",
            ))
        }
        _ => refusal(
            StatusCode::UNAUTHORIZED,
            "step_up_failed",
            "패스키 본인 확인에 실패했습니다",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_assertions_are_refused_and_database_failures_remain_server_errors() {
        assert_eq!(
            step_up_error(MobilePasskeyStepUpVerificationError::BindingMismatch).code,
            "step_up_failed"
        );
        assert_eq!(
            step_up_error(AuthError::InvalidStoredData("ceremony already consumed".into()).into())
                .status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            step_up_error(AuthError::Sqlx(sqlx::Error::PoolClosed).into()).status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn correction_binding_covers_event_employee_and_every_payload_field()
    -> Result<(), serde_json::Error> {
        let employee = Uuid::new_v4();
        let event = Uuid::new_v4();
        let mut request: CorrectLifecycleEventRequest = serde_json::from_value(json!({
            "replacement": {"event_type": "LEAVE_OF_ABSENCE", "effective_date": "2026-09-01", "comment": "정정", "expected_return_date": "2026-12-01"},
            "reason_code": "INPUT_ERROR"
        }))?;
        let binding = lifecycle_correction_binding(employee, event, &request);
        let reordered: CorrectLifecycleEventRequest = serde_json::from_str(
            r#"{"reason_code":" INPUT_ERROR ","replacement":{"expected_return_date":"2026-12-01","comment":"정정","effective_date":"2026-09-01","event_type":"LEAVE_OF_ABSENCE"}}"#,
        )?;
        assert_eq!(
            binding,
            lifecycle_correction_binding(employee, event, &reordered)
        );
        assert_ne!(
            binding,
            lifecycle_correction_binding(employee, Uuid::new_v4(), &request)
        );
        assert_ne!(
            binding,
            lifecycle_correction_binding(Uuid::new_v4(), event, &request)
        );
        request.replacement["comment"] = json!("다른 내용");
        assert_ne!(
            binding,
            lifecycle_correction_binding(employee, event, &request)
        );
        request.replacement["comment"] = json!("정정");
        request.replacement["expected_return_date"] = json!("2026-12-02");
        assert_ne!(
            binding,
            lifecycle_correction_binding(employee, event, &request)
        );
        request.replacement["expected_return_date"] = json!("2026-12-01");
        request.note = Some("근거".into());
        assert_ne!(
            binding,
            lifecycle_correction_binding(employee, event, &request)
        );
        Ok(())
    }
}
