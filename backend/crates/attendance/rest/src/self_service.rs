//! Read-only attendance projections for the authenticated principal's linked
//! employee. This module intentionally has no manager authorization branch.

use axum::{Json, extract::State, http::HeaderMap};
use console_attendance_application::{
    ListOwnExceptions, OwnAttendanceExceptionRead, OwnExceptionResolutionRead, OwnWeek52Read,
    ReadOwnWeek52, SelfAttendanceScope, Week52Tone,
};
use console_attendance_domain::AttendanceDateRange;
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, UtcOffset};

use crate::{
    AttendanceQuery, AttendanceRestState, RestError, parse_date, parse_month_range, principal,
    record_read,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OwnExceptionsQuery {
    month: Option<String>,
    from_date: Option<String>,
    to_date: Option<String>,
    work_date: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OwnWeek52Query {
    week_start: String,
}

#[derive(Serialize)]
struct OwnExceptionResolutionDto {
    action: String,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ot_hours: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    resolved_at: OffsetDateTime,
}

impl From<OwnExceptionResolutionRead> for OwnExceptionResolutionDto {
    fn from(value: OwnExceptionResolutionRead) -> Self {
        Self {
            action: value.action.as_db().to_owned(),
            reason: value.reason,
            ot_hours: value.ot_hours,
            resolved_at: value.resolved_at.to_offset(UtcOffset::UTC),
        }
    }
}

#[derive(Serialize)]
struct OwnExceptionDto {
    id: String,
    code: String,
    kind: String,
    status: String,
    work_date: String,
    #[serde(with = "time::serde::rfc3339")]
    occurred_at: OffsetDateTime,
    detail: String,
    evidence: Vec<OwnEvidenceDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<OwnExceptionResolutionDto>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(Serialize)]
struct OwnEvidenceDto {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<String>,
}

impl From<OwnAttendanceExceptionRead> for OwnExceptionDto {
    fn from(value: OwnAttendanceExceptionRead) -> Self {
        Self {
            id: value.id.to_string(),
            code: value.code,
            kind: value.kind.as_db().to_owned(),
            status: value.status,
            work_date: value.work_date.to_string(),
            occurred_at: value.occurred_at.to_offset(UtcOffset::UTC),
            detail: value.detail,
            evidence: value
                .evidence
                .into_iter()
                .map(|evidence| OwnEvidenceDto {
                    name: evidence.name,
                    size: evidence.size,
                })
                .collect(),
            resolution: value.resolution.map(OwnExceptionResolutionDto::from),
            created_at: value.created_at.to_offset(UtcOffset::UTC),
        }
    }
}

#[derive(Serialize)]
pub(super) struct OwnExceptionPageDto {
    items: Vec<OwnExceptionDto>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Serialize)]
struct OwnWeek52Dto {
    week_start: String,
    current_hours: f64,
    projected_hours: f64,
    tone: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "time::serde::rfc3339::option")]
    acknowledged_at: Option<OffsetDateTime>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum OwnWeek52Status {
    Available,
    NotAvailable,
}

#[derive(Serialize)]
pub(super) struct OwnWeek52Response {
    status: OwnWeek52Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    projection: Option<OwnWeek52Dto>,
}

impl From<Option<OwnWeek52Read>> for OwnWeek52Response {
    fn from(value: Option<OwnWeek52Read>) -> Self {
        match value {
            Some(projection) => Self {
                status: OwnWeek52Status::Available,
                projection: Some(OwnWeek52Dto::from(projection)),
            },
            None => Self {
                status: OwnWeek52Status::NotAvailable,
                projection: None,
            },
        }
    }
}

impl From<OwnWeek52Read> for OwnWeek52Dto {
    fn from(value: OwnWeek52Read) -> Self {
        Self {
            week_start: value.week_start.to_string(),
            current_hours: value.current_hours,
            projected_hours: value.projected_hours,
            tone: match value.tone {
                Week52Tone::Ok => "OK",
                Week52Tone::Warn => "WARN",
                Week52Tone::Danger => "DANGER",
                Week52Tone::Unknown => "UNKNOWN",
            }
            .to_owned(),
            acknowledged_at: value.acknowledged_at.map(|at| at.to_offset(UtcOffset::UTC)),
        }
    }
}

pub(super) async fn list_own_exceptions(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    AttendanceQuery(query): AttendanceQuery<OwnExceptionsQuery>,
) -> Result<Json<OwnExceptionPageDto>, RestError> {
    let principal = principal(&state, &headers).await?;
    let query = ListOwnExceptions::new(
        own_list_range(&query)?,
        query.status,
        query.limit,
        query.offset,
    )
    .map_err(validation)?;
    record_read("me_exceptions");
    let page = state
        .store
        .list_own_exceptions(self_scope(&principal), query)
        .await
        .map_err(RestError::store)?;
    let subjects = page
        .items
        .iter()
        .map(|row| row.employee_id)
        .collect::<Vec<_>>();
    super::audit::read(
        &state,
        &principal,
        "attendance.own_exceptions_read",
        "query".to_owned(),
        &subjects,
        subjects.first().copied(),
    )
    .await?;
    Ok(Json(OwnExceptionPageDto {
        items: page.items.into_iter().map(OwnExceptionDto::from).collect(),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
    }))
}

pub(super) async fn read_own_week52(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    AttendanceQuery(query): AttendanceQuery<OwnWeek52Query>,
) -> Result<Json<OwnWeek52Response>, RestError> {
    let principal = principal(&state, &headers).await?;
    let week_start = parse_date(&query.week_start, "week_start")?;
    let query = ReadOwnWeek52::new(week_start).map_err(validation)?;
    record_read("me_week52");
    let result = state
        .store
        .read_own_week52(self_scope(&principal), query)
        .await
        .map_err(RestError::store)?;
    let subjects = result
        .as_ref()
        .map(|row| row.employee_id)
        .into_iter()
        .collect::<Vec<_>>();
    super::audit::read(
        &state,
        &principal,
        "attendance.own_week52_read",
        "query".to_owned(),
        &subjects,
        subjects.first().copied(),
    )
    .await?;
    Ok(Json(OwnWeek52Response::from(result)))
}

fn own_list_range(query: &OwnExceptionsQuery) -> Result<AttendanceDateRange, RestError> {
    let selectors = usize::from(query.month.is_some())
        + usize::from(query.work_date.is_some())
        + usize::from(query.from_date.is_some() || query.to_date.is_some());
    if selectors != 1 {
        return Err(validation_message("supply exactly one date selector"));
    }
    match (
        &query.month,
        &query.work_date,
        &query.from_date,
        &query.to_date,
    ) {
        (Some(month), None, None, None) => parse_month_range(month),
        (None, Some(day), None, None) => {
            let date = parse_date(day, "work_date")?;
            AttendanceDateRange::new(date, date + time::Duration::days(1))
                .map_err(|error| validation_message(error.to_string()))
        }
        (None, None, Some(from), Some(to)) => {
            AttendanceDateRange::new(parse_date(from, "from_date")?, parse_date(to, "to_date")?)
                .map_err(|error| validation_message(error.to_string()))
        }
        _ => Err(validation_message("invalid date selector")),
    }
}

fn self_scope(principal: &console_platform_authz::Principal) -> SelfAttendanceScope {
    SelfAttendanceScope {
        org_id: *principal.org_id.as_uuid(),
        user_id: *principal.user_id.as_uuid(),
    }
}

fn validation(error: console_attendance_application::AttendanceApplicationError) -> RestError {
    validation_message(error.to_string())
}

fn validation_message(message: impl Into<String>) -> RestError {
    RestError::new(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "validation",
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_attendance_application::{OwnWeek52Read, Week52Tone};
    use serde_json::json;
    use time::{Date, Month};

    #[test]
    fn own_attendance_timestamps_normalize_offsets_to_utc() {
        let at = time::macros::datetime!(2026-11-05 12:31:02.238349 +09:00);
        let value = serde_json::to_value(OwnExceptionDto::from(OwnAttendanceExceptionRead {
            employee_id: uuid::Uuid::nil(),
            id: uuid::Uuid::nil(),
            code: "AT-1".into(),
            kind: console_attendance_domain::ExceptionKind::Late,
            status: "RESOLVED".into(),
            work_date: at.date(),
            occurred_at: at,
            detail: "late".into(),
            evidence: vec![],
            created_at: at,
            resolution: Some(OwnExceptionResolutionRead {
                action: console_attendance_domain::ResolutionAction::Confirm,
                reason: "verified".into(),
                ot_hours: None,
                resolved_at: at,
            }),
        }))
        .unwrap();
        let week = serde_json::to_value(OwnWeek52Dto::from(OwnWeek52Read {
            employee_id: uuid::Uuid::nil(),
            week_start: at.date(),
            current_hours: 40.0,
            projected_hours: 40.0,
            tone: Week52Tone::Ok,
            acknowledged_at: Some(at),
        }))
        .unwrap();
        for value in [
            &value["occurred_at"],
            &value["created_at"],
            &value["resolution"]["resolved_at"],
            &week["acknowledged_at"],
        ] {
            assert_eq!(value, "2026-11-05T03:31:02.238349Z");
        }
    }

    #[test]
    fn own_week52_available_response_has_only_status_and_projection() {
        let projection = OwnWeek52Read {
            employee_id: uuid::Uuid::nil(),
            week_start: Date::from_calendar_date(2026, Month::July, 20).unwrap(),
            current_hours: 24.0,
            projected_hours: 32.0,
            tone: Week52Tone::Warn,
            acknowledged_at: None,
        };
        assert_eq!(
            serde_json::to_value(OwnWeek52Response::from(Some(projection))).unwrap(),
            json!({
                "status": "available",
                "projection": {
                    "week_start": "2026-07-20",
                    "current_hours": 24.0,
                    "projected_hours": 32.0,
                    "tone": "WARN"
                }
            })
        );
    }

    #[test]
    fn own_week52_not_available_response_omits_projection() {
        assert_eq!(
            serde_json::to_value(OwnWeek52Response::from(None)).unwrap(),
            json!({"status": "not_available"})
        );
    }
}
