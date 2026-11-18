// SPDX-License-Identifier: LicenseRef-Proprietary
//! Independent review uses the verified actor and the transaction's current Cedar facts.
use crate::{
    error::RestError, policy::dto::PolicyStepUpAssertionRequest, state::IdentityRestState,
};
use axum::{
    Extension, Json,
    extract::{Path, State},
};
use console_identity_adapter_postgres::self_binding_review::ReviewDecision;
use console_platform_authz::Principal;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum Decision {
    Confirm,
    Revoke,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReviewRequest {
    decision: Decision,
    step_up: Option<PolicyStepUpAssertionRequest>,
}

pub(crate) async fn review(
    State(state): State<IdentityRestState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<ReviewRequest>,
) -> Result<Json<Value>, RestError> {
    let proof = crate::policy::step_up::verify_step_up(
        &state,
        &principal,
        body.step_up,
        "Confirm this review with your own passkey",
    )
    .await?;
    let trace = console_platform_request_context::current_audit_context()
        .ok_or_else(|| RestError::internal("Request audit context is unavailable"))?
        .trace;
    let decision = match body.decision {
        Decision::Confirm => ReviewDecision::Confirm,
        Decision::Revoke => ReviewDecision::Revoke,
    };
    state
        .store
        .review_self_binding(id, decision, proof, trace)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(json!({})))
}
