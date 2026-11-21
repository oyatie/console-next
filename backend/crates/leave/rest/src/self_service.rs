// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-service leave REST handlers (`/api/v2/me/leave/team-overlap`,
//! `/api/v2/me/leave/approval-preview`).

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use console_leave_adapter_postgres::PgLeaveError;
use console_leave_application::SelfLeaveTeamOverlapQuery;
use serde::Deserialize;

use crate::{LeaveRestState, RestError, principal_from_headers};

pub(crate) fn map_store_error(err: PgLeaveError) -> RestError {
    match err {
        PgLeaveError::Domain(err) => RestError::from_kernel(err),
        PgLeaveError::MissingHomeBranch => RestError::new(
            StatusCode::CONFLICT,
            "leave_home_branch_review_required",
            "an active linked employee needs an explicit home branch before filing leave",
        ),
        PgLeaveError::OverlappingRequest => RestError::new(
            StatusCode::CONFLICT,
            "leave_overlapping_request",
            "leave request overlaps an existing pending or approved leave request",
        ),
        PgLeaveError::PeriodClosed => RestError::new(
            StatusCode::CONFLICT,
            "leave_period_closed",
            "leave request covers a closed attendance or payroll period",
        ),
        PgLeaveError::ChargeReviewRequired(reasons) => {
            let mut error = RestError::new(
                StatusCode::CONFLICT,
                "leave_calendar_review_required",
                "leave charge evidence must be resolved before approval",
            );
            error.reasons = reasons
                .into_iter()
                .map(|reason| reason.as_str().to_owned())
                .collect();
            error
        }
        PgLeaveError::ConcurrentModification => RestError::new(
            StatusCode::CONFLICT,
            "leave_concurrent_modification",
            "leave request_version changed since it was read; reload before retrying",
        ),
        PgLeaveError::CommandUnavailable => RestError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "leave_command_unavailable",
            "leave command database is not configured or unavailable",
        ),
        PgLeaveError::Db(_) => {
            tracing::error!(error = %err, "leave store error");
            RestError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error",
            )
        }
    }
}

fn parse_iso_date(raw: &str, field: &str) -> Result<console_kernel_core::Date, RestError> {
    time::Date::parse(
        raw.trim(),
        &time::format_description::well_known::Iso8601::DATE,
    )
    .map_err(|_| {
        RestError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            format!("{field} must be a YYYY-MM-DD date"),
        )
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TeamOverlapParams {
    pub start_date: String,
    pub end_date: String,
}

pub(crate) async fn get_my_leave_team_overlap(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Query(params): Query<TeamOverlapParams>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let start_date = parse_iso_date(&params.start_date, "start_date")?;
    let end_date = parse_iso_date(&params.end_date, "end_date")?;
    if end_date < start_date {
        return Err(RestError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "end_date must be on or after start_date",
        ));
    }
    if (end_date - start_date).whole_days() >= 366 {
        return Err(RestError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "date range must be shorter than 366 days",
        ));
    }
    let view = state
        .store
        .get_self_team_overlap(SelfLeaveTeamOverlapQuery {
            requester: principal.user_id,
            start_date,
            end_date,
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(view))
}

pub(crate) async fn get_my_leave_approval_preview(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let view = state
        .store
        .get_self_approval_preview(principal.user_id)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(view))
}
