// SPDX-License-Identifier: LicenseRef-Proprietary
//! K1 ACCOUNT-LINK-GUARD: a changed employee link needs the actor's own passkey and,
//! where policy asks, an independent approval; every refusal is audited with a reference.

use crate::error::RestError;
use crate::state::IdentityRestState;
use crate::users::dto::UpdateUserRequest;
use axum::Json;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use console_identity_application::UpdateUserCommand;
use console_kernel_core::TraceContext;
use console_kernel_core::UserId;
use time::OffsetDateTime;

pub(super) async fn change_account_link(
    state: &IdentityRestState,
    principal: &console_platform_authz::Principal,
    target: UserId,
    body: UpdateUserRequest,
    trace: TraceContext,
) -> Result<axum::response::Response, RestError> {
    if body.display_name.is_some()
        || body.phone.is_some()
        || body.team.is_some()
        || body.roles.is_some()
        || body.branch_ids.is_some()
    {
        return Err(RestError::validation(
            "직원 연결 변경은 다른 계정 정보와 나누어 요청하십시오",
        ));
    }
    if body.employee_id.is_none() {
        return Err(RestError::validation("employee_id is required"));
    }
    let step_up = crate::policy::step_up::verify_step_up(
        state,
        principal,
        body.step_up,
        "직원 연결 변경은 내 패스키로 본인 확인을 해야 합니다",
    )
    .await
    .map_err(|mut error| {
        if error.code == "passkey_step_up_required" {
            error.code = "step_up_required";
        }
        if error.code == "unauthorized" {
            error.code = "step_up_failed";
            error.message =
                "패스키를 확인하지 못했습니다. 내 패스키로 다시 확인하십시오".to_owned();
        }
        error
    })?;
    let result = state
        .store
        .change_account_link(
            UpdateUserCommand {
                actor: principal.user_id,
                user_id: target,
                employee_id: body.employee_id,
                display_name: None,
                phone: None,
                team: None,
                roles: None,
                branch_ids: None,
                preview_receipt_id: None,
                trace,
                occurred_at: OffsetDateTime::now_utc(),
            },
            body.account_link_request_id,
            step_up,
        )
        .await
        .map_err(RestError::from_store)?;
    if result
        .account_link
        .as_ref()
        .is_some_and(|request| request.status == "PENDING")
    {
        Ok((StatusCode::ACCEPTED, Json(result)).into_response())
    } else {
        Ok(Json(result.user).into_response())
    }
}

pub(super) async fn account_link_refusal(
    state: &IdentityRestState,
    actor: UserId,
    target: UserId,
    trace: TraceContext,
    mut error: RestError,
) -> RestError {
    if let Err(audit_error) = state
        .store
        .record_account_link_refusal(actor, target, trace.clone(), error.code)
        .await
    {
        error = RestError::from_store(audit_error);
    }
    tracing::warn!(
        code = error.code,
        reference = trace.trace_id(),
        "account link refused"
    );
    error.message = format!("{} (reference={})", error.message, trace.trace_id());
    error
}
