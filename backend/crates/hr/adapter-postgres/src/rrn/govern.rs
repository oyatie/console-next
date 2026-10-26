// SPDX-License-Identifier: LicenseRef-Proprietary
//! One binding and one transaction gate for personal-field reveals (SEC-01).
use super::FieldRevealRequest;
use crate::{
    HrError,
    authz::{hr_reach, out_of_scope, person_in_reach},
    digest::sha256_hex,
    import::caps::settings_in_tx,
};
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind, PasskeyService,
};
use console_platform_authz::{
    Feature, Principal,
    cedar_pbac::actions::employee_pii::{self, PiiFacts},
};
use console_settings_adapter_postgres::validate_reason_in_tx;
use console_settings_domain::{SettingKey, code_lists::ReasonDomain};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub fn reveal_binding(employee: Uuid, field: &str, reason: &str) -> MobilePasskeyStepUpBinding {
    MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::PiiReveal,
        employee,
        sha256_hex(format!("{field}:{}", reason.trim()).as_bytes()),
    )
}

pub(super) fn required() -> HrError {
    refused(
        http::StatusCode::UNAUTHORIZED,
        "step_up_required",
        "a bound passkey assertion is required",
    )
}

fn refused(status: http::StatusCode, code: &'static str, message: &str) -> HrError {
    HrError {
        status,
        code,
        message: message.into(),
        errors: None,
        refusals: None,
    }
}

pub(super) async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    employee: Uuid,
    request: FieldRevealRequest,
    passkeys: Option<&PasskeyService>,
) -> Result<i64, HrError> {
    let reach = hr_reach(principal, Feature::EmployeeDirectoryManage);
    let subject_in_scope = match &reach {
        Ok(reach) => person_in_reach(tx, reach, employee).await?,
        Err(_) => false,
    };
    let reason = request.reason_code.trim();
    let purpose = validate_reason_in_tx(
        tx.as_mut(),
        principal.org_id,
        ReasonDomain::RrnReveal,
        reason,
        request.note.as_deref(),
    )
    .await
    .map_err(|error| {
        let code = error.code;
        let mut hr = HrError::from_kernel(error);
        if let Some(code) = code {
            hr.code = code;
        }
        hr
    });
    let purpose = match purpose {
        Err(error) if error.status.is_server_error() => return Err(error),
        result => result,
    };
    // Serialize this actor across subjects and field classes so concurrent requests cannot exceed the ceiling.
    sqlx::query("SELECT id FROM users WHERE org_id=$1 AND id=$2 FOR UPDATE")
        .bind(principal.org_id.as_uuid())
        .bind(principal.user_id.as_uuid())
        .execute(tx.as_mut())
        .await?;
    let keys = [
        SettingKey::PrivacyRevealDisplaySeconds,
        SettingKey::PrivacyRevealRatePerHour,
    ];
    let settings = settings_in_tx(tx, *principal.org_id.as_uuid(), &keys).await?;
    let int = |key| {
        settings
            .get(&key)
            .and_then(|v| v.as_int())
            .ok_or_else(|| HrError::internal("reveal policy did not resolve"))
    };
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND actor=$2 AND action IN ('employee.rrn_reveal','employee.field_reveal') AND created_at > now() - interval '1 hour'")
        .bind(principal.org_id.as_uuid()).bind(principal.user_id.as_uuid()).fetch_one(tx.as_mut()).await?;
    let within_rate = count < int(SettingKey::PrivacyRevealRatePerHour)?;
    let proof_missing = request.step_up.is_none() || passkeys.is_none();
    let step_up = match (request.step_up, passkeys) {
        (Some(proof), Some(passkeys)) => {
            verify_step_up(
                tx,
                principal,
                employee,
                request.field.as_str(),
                reason,
                proof,
                passkeys,
            )
            .await
        }
        _ => Err(required()),
    };
    let step_up = match step_up {
        Err(error) if error.status.is_server_error() => return Err(error),
        result => result,
    };
    let allowed = employee_pii::decide(
        &principal.user_id.to_string(),
        &principal.org_id.to_string(),
        PiiFacts {
            operation: "reveal",
            field: request.field.as_str(),
            actor_manages_directory: reach.is_ok(),
            subject_in_scope,
            purpose_given: purpose.is_ok(),
            step_up_verified: step_up.is_ok(),
            within_rate,
        },
    )
    .map_err(HrError::internal)?;
    if !allowed {
        reach?;
        if !subject_in_scope {
            return Err(out_of_scope(principal, Feature::EmployeeDirectoryManage));
        }
        if proof_missing {
            return Err(required());
        }
        purpose?;
        if !within_rate {
            metrics::counter!("hr_employee_pii_total", "operation" => "reveal", "outcome" => "reveal_rate_limited").increment(1);
            return Err(refused(
                http::StatusCode::TOO_MANY_REQUESTS,
                "reveal_rate_limited",
                "retry after the oldest reveal leaves the rolling one-hour window",
            ));
        }
        step_up?;
        return Err(refused(
            http::StatusCode::FORBIDDEN,
            "forbidden",
            "personal-field reveal denied",
        ));
    }
    int(SettingKey::PrivacyRevealDisplaySeconds)
}

// Storage failures stop the transaction; invalid or stale assertions become Cedar facts.
async fn verify_step_up(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    employee: Uuid,
    field: &str,
    reason: &str,
    proof: MobilePasskeyStepUpEnvelope,
    passkeys: &PasskeyService,
) -> Result<(), HrError> {
    let fresh: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM auth_webauthn_ceremony_bindings WHERE ceremony_id=$1 AND created_at <= now() AND created_at >= now() - interval '5 minutes')")
        .bind(proof.assertion.ceremony_id).fetch_one(tx.as_mut()).await?;
    passkeys
        .verify_and_record_step_up_in_tx(
            tx,
            proof,
            *principal.user_id.as_uuid(),
            &reveal_binding(employee, field, reason),
        )
        .await
        .map_err(|error| {
            if matches!(
                error,
                console_platform_auth::MobilePasskeyStepUpVerificationError::Auth(
                    console_platform_auth::AuthError::Sqlx(_)
                        | console_platform_auth::AuthError::Db(_)
                )
            ) {
                return HrError::internal("passkey verification storage failed");
            }
            refused(
                http::StatusCode::UNAUTHORIZED,
                "passkey_step_up_failed",
                "the passkey assertion does not authorize this reveal",
            )
        })?;
    if !fresh {
        return Err(refused(
            http::StatusCode::UNAUTHORIZED,
            "passkey_step_up_failed",
            "the passkey assertion is not fresh",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "govern_tests.rs"]
mod tests;
