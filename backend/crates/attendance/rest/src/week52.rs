// SPDX-License-Identifier: LicenseRef-Proprietary
//! The weekly monitor uses the same Cedar read snapshot as the attendance board.
use crate::read_dto::{Week52BoardDto, Week52RowDto};
use crate::{
    AttendanceQuery, AttendanceRestState, RestError, audit, parse_date, principal, record_read,
    records, validate_week52_start,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Week52Query {
    week_start: String,
    branch_id: Option<Uuid>,
}
pub(super) async fn week52(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<Week52Query>,
) -> Result<Json<Week52BoardDto>, RestError> {
    let p = principal(&state, &headers).await?;
    record_read("week52");
    let week_start =
        validate_week52_start(parse_date(&q.week_start, "weekStart")?).map_err(|e| {
            RestError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                e.to_string(),
            )
        })?;
    let items = state
        .store
        .week52_inputs(
            &records::read_scope(&p),
            week_start,
            q.branch_id,
            records::access::load!(p.org_id, *p.user_id.as_uuid()),
        )
        .await
        .map_err(RestError::store)?;
    let subjects = items.iter().map(|row| row.employee_id).collect::<Vec<_>>();
    audit::read(
        &state,
        &p,
        "attendance.week52_read",
        "query".to_owned(),
        &subjects,
        None,
    )
    .await?;
    Ok(Json(Week52BoardDto {
        week_start: week_start.to_string(),
        items: items.into_iter().map(Week52RowDto::from).collect(),
    }))
}
