//! Handlers: 근무조, 휴일, and one's own month.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use console_attendance_application::calendar::{
    ContractualHoliday, CrewInput, CrewMembersInput, CrewRead, HolidayInput, HolidayPreview,
    HolidayRetireInput, HolidayYear,
};
use console_attendance_application::schedule::{Items, ScheduleCalendar};

use serde::Deserialize;

use uuid::Uuid;

use super::{Body, READ, WRITE, caller};
use crate::{AttendanceQuery, AttendanceRestState, RestError, idempotency, principal};

use super::handlers::{Created, Res, created, opt_date};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CrewsQuery {
    workplace_id: Option<Uuid>,
    date: Option<String>,
}

pub(super) async fn list_crews(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<CrewsQuery>,
) -> Res<Items<CrewRead>> {
    let p = principal(&s, &h).await?;
    let c = caller(&p, READ)?;
    let date = opt_date(q.date.as_ref(), "date")?;
    let crews = s
        .store
        .list_crews(&c, q.workplace_id, date)
        .await
        .map_err(RestError::schedule)?;
    let subjects = crews
        .items
        .iter()
        .flat_map(|crew| crew.members.iter().map(|member| member.employee_id))
        .collect::<Vec<_>>();
    crate::audit::read(
        &s,
        &p,
        "attendance.crews_read",
        "query".to_owned(),
        &subjects,
        None,
    )
    .await?;
    Ok(Json(crews))
}

pub(super) async fn create_crew(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Body(b): Body<CrewInput>,
) -> Created<CrewRead> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    let key = idempotency(&h)?;
    Ok(created(
        s.store
            .create_crew(&c, &key, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}

pub(super) async fn place_members(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Body(b): Body<CrewMembersInput>,
) -> Res<CrewRead> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    let key = idempotency(&h)?;
    Ok(Json(
        s.store
            .place_crew_members(&c, id, &key, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct YearQuery {
    year: i32,
}

pub(super) async fn holidays(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<YearQuery>,
) -> Res<HolidayYear> {
    let c = caller(&principal(&s, &h).await?, READ)?;
    if !(2000..=2100).contains(&q.year) {
        return Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "year_invalid",
            "year is out of range",
        ));
    }
    Ok(Json(
        s.store
            .holiday_year(&c, q.year)
            .await
            .map_err(RestError::schedule)?,
    ))
}

pub(super) async fn preview_holiday(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Body(b): Body<HolidayInput>,
) -> Res<HolidayPreview> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    Ok(Json(
        s.store
            .preview_holiday(&c, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}

pub(super) async fn create_holiday(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Body(b): Body<HolidayInput>,
) -> Created<ContractualHoliday> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    let key = idempotency(&h)?;
    Ok(created(
        s.store
            .create_holiday(&c, &key, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}

pub(super) async fn retire_holiday(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Body(b): Body<HolidayRetireInput>,
) -> Res<ContractualHoliday> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    Ok(Json(
        s.store
            .retire_holiday(&c, id, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MonthQuery {
    month: String,
}

/// The signed-in person's own month; no grant needed beyond a linked account.
pub(super) async fn me(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<MonthQuery>,
) -> Res<ScheduleCalendar> {
    let p = principal(&s, &h).await?;
    let (org, user) = (*p.org_id.as_uuid(), *p.user_id.as_uuid());
    let calendar = s
        .store
        .own_schedule(org, user, q.month)
        .await
        .map_err(RestError::schedule)?;
    crate::audit::read(
        &s,
        &p,
        "attendance.own_schedule_read",
        calendar.scope_id.to_string(),
        &[calendar.scope_id],
        Some(calendar.scope_id),
    )
    .await?;
    Ok(Json(calendar))
}
