// SPDX-License-Identifier: LicenseRef-Proprietary
//! The principal selects an employee, never an account or eligibility facts.
use crate::{error::RestError, state::IdentityRestState};
use axum::{Extension, Json, extract::State, http::StatusCode};
use console_identity_adapter_postgres::self_binding::SelfBindingCommand;
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, PasskeyService,
};
use console_platform_authz::Principal;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PrepareRequest {
    employee_id: Uuid,
    confirmed_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BindRequest {
    employee_id: Uuid,
    confirmed_name: Option<String>,
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}

fn passkeys(state: &IdentityRestState) -> Result<&PasskeyService, RestError> {
    state
        .passkey_step_up
        .as_ref()
        .ok_or_else(|| RestError::unavailable("Passkey step-up is not configured for identity API"))
}

pub(crate) async fn prepare(
    State(state): State<IdentityRestState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<PrepareRequest>,
) -> Result<Json<MobilePasskeyStepUpBinding>, RestError> {
    let binding = state
        .store
        .prepare_self_binding(principal.user_id, body.employee_id, body.confirmed_name)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(binding))
}

pub(crate) async fn bind(
    State(state): State<IdentityRestState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<BindRequest>,
) -> Result<(StatusCode, Json<Value>), RestError> {
    let step_up = body.step_up.ok_or_else(|| {
        RestError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "step_up_required",
            "Confirm this binding with your own passkey",
        )
    })?;
    let receipt = state
        .store
        .self_bind_account(
            SelfBindingCommand {
                actor: principal.user_id,
                employee: body.employee_id,
                confirmed_name: body.confirmed_name,
                step_up,
                trace: console_platform_request_context::current_audit_context()
                    .ok_or_else(|| RestError::internal("Request audit context is unavailable"))?
                    .trace,
            },
            passkeys(&state)?,
        )
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(json!({"attestation_id":receipt}))))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WithdrawRequest {
    attestation_id: Uuid,
    step_up: Option<crate::policy::dto::PolicyStepUpAssertionRequest>,
}

pub(crate) async fn withdraw(
    State(state): State<IdentityRestState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<WithdrawRequest>,
) -> Result<Json<Value>, RestError> {
    let proof = crate::policy::step_up::verify_step_up(
        &state,
        &principal,
        body.step_up,
        "Confirm withdrawal with your own passkey",
    )
    .await?;
    let trace = console_platform_request_context::current_audit_context()
        .ok_or_else(|| RestError::internal("Request audit context is unavailable"))?
        .trace;
    state
        .store
        .review_self_binding(
            body.attestation_id,
            console_identity_adapter_postgres::self_binding_review::ReviewDecision::Withdraw,
            proof,
            trace,
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(json!({})))
}

/// Receipt recovery uses live Cedar facts even before the account has an employee.
pub(crate) async fn receipt(
    State(state): State<IdentityRestState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<Value>, RestError> {
    state
        .store
        .self_binding_receipt(principal.user_id)
        .await
        .map(Json)
        .map_err(RestError::from_store)
}
