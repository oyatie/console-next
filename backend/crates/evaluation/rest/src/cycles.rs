// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateCycleRequest {
    name: String,
    kind: console_evaluation_domain::CycleKind,
    period_label: String,
    #[serde(with = "console_evaluation_application::date_fmt")]
    due_date: time::Date,
}

#[derive(Debug, Deserialize)]
pub(super) struct CycleListFilter {
    stage: Option<CycleStage>,
    limit: Option<i64>,
    offset: Option<i64>,
}

const READ: Feature = Feature::EvaluationRead;
const MANAGE: Feature = Feature::EvaluationManage;

/// Register and create use different authorities. The mounted face supplies both for navigation.
pub fn cycle_access(principal: &Principal) -> (bool, bool) {
    (
        holds_feature(principal, READ),
        holds_feature(principal, MANAGE),
    )
}

pub(super) async fn create_cycle(
    State(state): State<EvaluationRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateCycleRequest>,
) -> Result<(StatusCode, Json<CycleDetail>), RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_feature(&principal, MANAGE)?;
    let name = bounded_required(&body.name, 1, NAME_MAX_CHARS, "name")?;
    let period_label = bounded_required(
        &body.period_label,
        1,
        PERIOD_LABEL_MAX_CHARS,
        "period_label",
    )?;
    let detail = state
        .store
        .create_cycle(
            principal.user_id,
            CreateCycleInput {
                name,
                kind: body.kind,
                period_label,
                due_date: body.due_date,
            },
        )
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(detail)))
}

pub(super) async fn list_cycles(
    State(state): State<EvaluationRestState>,
    headers: HeaderMap,
    Query(filter): Query<CycleListFilter>,
) -> Result<Json<CyclePage>, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_feature(&principal, READ)?;
    let page = state
        .store
        .list_cycles(CycleQuery {
            stage: filter.stage,
            limit: filter
                .limit
                .unwrap_or(DEFAULT_CYCLE_LIMIT)
                .clamp(1, MAX_CYCLE_LIMIT),
            offset: filter.offset.unwrap_or(0).max(0),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
}
