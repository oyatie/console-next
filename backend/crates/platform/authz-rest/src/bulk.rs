// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

/// Per-check decisions, aligned by index with the request `checks`.
#[derive(Debug, Serialize)]
struct BulkDecisionResponse {
    decisions: Vec<SimulationOutcome>,
}

pub(super) async fn authorize_bulk(
    State(state): State<CedarPolicyRestState>,
    headers: HeaderMap,
    Json(body): Json<BulkAuthorizeBody>,
) -> Result<impl IntoResponse, RestError> {
    let principal = authorize_admin(&state, &headers).await?;
    let subject_bytes = serde_json::to_vec(&body.subject)
        .map_err(|_| RestError::internal("could not measure authorization subject"))?
        .len();
    if body.checks.len() > limits::BULK_CHECKS_MAX
        || subject_bytes
            .checked_mul(body.checks.len())
            .is_none_or(|work| work > limits::BULK_SUBJECT_WORK_BYTES_MAX)
    {
        return Err(RestError::from_kernel(
            KernelError::validation("policy bulk request exceeds the evaluation limit")
                .with_code("policy_bulk_limit"),
        ));
    }
    // Load the enforced set ONCE, then evaluate every check against it.
    let policies = state
        .store
        .load_enforced_policies()
        .await
        .map_err(RestError::from_store)?;
    let BulkAuthorizeBody { subject, checks } = body;
    let mut decisions = Vec::with_capacity(checks.len());
    let mut entries = Vec::with_capacity(checks.len());
    for check in checks {
        let request = SimRequest {
            subject: subject.clone(),
            action: check.action,
            resource: check.resource,
            purpose: check.purpose,
            field: check.field,
        };
        let outcome = simulate_policies(&policies, &request);
        entries.push(decision_entry(&request, &outcome));
        decisions.push(outcome);
    }
    state
        .store
        .record_decisions(*principal.user_id.as_uuid(), entries)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(BulkDecisionResponse { decisions }))
}
