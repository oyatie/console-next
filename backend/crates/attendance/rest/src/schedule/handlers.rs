//! Handlers: authenticate, scope, delegate, map refusals.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};

use console_attendance_application::schedule::{
    AssignInput, AssignReceipt, Items, LayerRead, PatternInput, PatternRead, ReasonInput,
    ScheduleCalendar, SchedulePreview, ScheduleTree,
};
use console_attendance_domain::schedule::Level;
use serde::Deserialize;
use time::Date;
use uuid::Uuid;

use super::{Body, READ, WRITE, caller};
use crate::{AttendanceQuery, AttendanceRestState, RestError, idempotency, parse_date, principal};

pub(super) type Res<T> = Result<Json<T>, RestError>;
pub(super) type Created<T> = Result<(StatusCode, Json<T>), RestError>;

pub(super) fn created<T>((v, fresh): (T, bool)) -> (StatusCode, Json<T>) {
    (
        if fresh {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(v),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PatternsQuery {
    include_retired: Option<bool>,
}

pub(super) async fn list_patterns(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<PatternsQuery>,
) -> Res<Items<PatternRead>> {
    let c = caller(&principal(&s, &h).await?, READ)?;
    Ok(Json(
        s.store
            .list_patterns(&c, q.include_retired.unwrap_or(false))
            .await
            .map_err(RestError::schedule)?,
    ))
}

pub(super) async fn create_pattern(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Body(b): Body<PatternInput>,
) -> Created<PatternRead> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    let key = idempotency(&h)?;
    Ok(created(
        s.store
            .create_pattern(&c, &key, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}

pub(super) async fn retire_pattern(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Res<PatternRead> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    Ok(Json(
        s.store
            .retire_pattern(&c, id)
            .await
            .map_err(RestError::schedule)?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DateQuery {
    date: Option<String>,
}

pub(super) fn opt_date(raw: Option<&String>, name: &str) -> Result<Option<Date>, RestError> {
    raw.map(|d| parse_date(d, name)).transpose()
}

pub(super) async fn tree(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<DateQuery>,
) -> Res<ScheduleTree> {
    let p = principal(&s, &h).await?;
    let c = caller(&p, READ)?;
    let date = opt_date(q.date.as_ref(), "date")?;
    let tree = s
        .store
        .schedule_tree(&c, date)
        .await
        .map_err(RestError::schedule)?;
    crate::audit::read_record(
        &s,
        &p,
        console_platform_request_context::audit_context::access_log::AccessRecord {
            action: "attendance.schedule_tree_read",
            target_type: "employee",
            target_id: "query".into(),
            subject_ids: &tree.access_subject_employees,
            reader_subject: None,
            details: serde_json::json!({}),
        },
        &[],
    )
    .await?;
    Ok(Json(tree))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ScopeQuery {
    scope_kind: String,
    scope_id: Uuid,
    month: Option<String>,
}

fn level(raw: &str) -> Result<Level, RestError> {
    Level::parse(raw).ok_or_else(|| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "scope_kind_invalid",
            "scope_kind is not a schedule scope",
        )
    })
}

pub(super) async fn calendar(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<ScopeQuery>,
) -> Res<ScheduleCalendar> {
    let p = principal(&s, &h).await?;
    let c = caller(&p, READ)?;
    let month = q.month.ok_or_else(|| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "month_invalid",
            "month is required",
        )
    })?;
    let calendar = s
        .store
        .schedule_calendar(&c, level(&q.scope_kind)?, q.scope_id, month)
        .await
        .map_err(RestError::schedule)?;
    if calendar.scope_kind == Level::Person {
        crate::audit::read(
            &s,
            &p,
            "attendance.schedule_read",
            calendar.scope_id.to_string(),
            &[calendar.scope_id],
            None,
        )
        .await?;
    }
    Ok(Json(calendar))
}

pub(super) async fn list_layers(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<ScopeQuery>,
) -> Res<Items<LayerRead>> {
    let p = principal(&s, &h).await?;
    let c = caller(&p, READ)?;
    let layers = s
        .store
        .list_layers(&c, level(&q.scope_kind)?, q.scope_id)
        .await
        .map_err(RestError::schedule)?;
    let mut users: Vec<_> = layers
        .items
        .iter()
        .flat_map(|l| l.access_subject_users.iter().copied())
        .collect();
    users.sort_unstable();
    users.dedup();
    let employees: Vec<_> = layers
        .items
        .iter()
        .filter(|l| l.scope_kind == Level::Person)
        .map(|l| l.scope_id)
        .take(1)
        .collect();
    crate::audit::read_record(
        &s,
        &p,
        console_platform_request_context::audit_context::access_log::AccessRecord {
            action: "attendance.layers_read",
            target_type: "attendance_schedule_layer",
            target_id: q.scope_id.to_string(),
            subject_ids: &employees,
            reader_subject: None,
            details: serde_json::json!({}),
        },
        &users,
    )
    .await?;
    Ok(Json(layers))
}

pub(super) async fn preview(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Body(b): Body<AssignInput>,
) -> Res<SchedulePreview> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    Ok(Json(
        s.store
            .preview_schedule(&c, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}

pub(super) async fn assign(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Body(b): Body<AssignInput>,
) -> Created<AssignReceipt> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    let key = idempotency(&h)?;
    Ok(created(
        s.store
            .assign_schedule(&c, &key, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}

pub(super) async fn cancel(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Body(b): Body<ReasonInput>,
) -> Res<LayerRead> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    Ok(Json(
        s.store
            .cancel_layer(&c, id, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}
