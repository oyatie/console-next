// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

const MY_TASKS_FEATURE: Feature = Feature::EvaluationSubmit;

/// The register and its navigation entry use the same current submitter decision.
pub fn my_tasks_available(principal: &Principal) -> bool {
    holds_feature(principal, MY_TASKS_FEATURE)
}

pub(super) async fn my_tasks(
    State(state): State<EvaluationRestState>,
    headers: HeaderMap,
) -> Result<Json<TaskPage>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_feature(&principal, MY_TASKS_FEATURE)?;
    let page = state
        .store
        .my_tasks(principal.user_id)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
}
