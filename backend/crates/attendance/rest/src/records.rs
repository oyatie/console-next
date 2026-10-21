//! 근태 기록 routes (ATT S2). Reads need the directory read key; writes the
//! attendance edit key on every person they touch (re-checked per cell).

#[path = "records_audit.rs"]
mod audit;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use console_attendance_adapter_postgres::{BoardQuery, GridQuery, ScheduleStoreError};
use console_attendance_application::records::{
    CorrectInput, PreviewInput, SaveInput, UndoInput, VoidInput,
};
use console_attendance_application::records_read::{
    DayBoard, MonthGrid, PersonMonth, SavePreview, SaveReceipt,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::schedule::{Body, READ, WRITE, caller};
use crate::{AttendanceQuery, AttendanceRestState, RestError, idempotency, parse_date, principal};

pub const DAYS_PATH: &str = "/api/v1/attendance/days";
pub const MONTH_PATH: &str = "/api/v1/attendance/month";
pub const PERSON_MONTH_PATH: &str = "/api/v1/attendance/people/{employee_id}/month";
pub const ENTRIES_PREVIEW_PATH: &str = "/api/v1/attendance/entries/preview";
pub const ENTRIES_PATH: &str = "/api/v1/attendance/entries";
pub const BATCH_UNDO_PATH: &str = "/api/v1/attendance/batches/{batch_id}/undo";
pub const ENTRY_CORRECT_PATH: &str = "/api/v1/attendance/entries/{entry_id}/correct";
pub const ENTRY_VOID_PATH: &str = "/api/v1/attendance/entries/{entry_id}/void";

pub(crate) fn router(state: AttendanceRestState) -> axum::Router<AttendanceRestState> {
    axum::Router::new()
        .route(DAYS_PATH, get(days))
        .route(MONTH_PATH, get(month))
        .route(PERSON_MONTH_PATH, get(person_month))
        .route(ENTRIES_PREVIEW_PATH, post(preview))
        .route(ENTRIES_PATH, post(save))
        .route(BATCH_UNDO_PATH, post(undo))
        .route(ENTRY_CORRECT_PATH, post(correct))
        .route(ENTRY_VOID_PATH, post(void))
        .layer(axum::middleware::from_fn_with_state(
            state,
            audit::read_refusal,
        ))
}

/// A refusal that carries its rows (409 `entry_conflict`, 422 `cells_refused`)
/// under `error.details`, the one place the console's `ApiError` keeps them.
pub(crate) fn refused(e: ScheduleStoreError) -> RestError {
    let (status, code, message, details) = match e {
        ScheduleStoreError::EntryConflict(conflicts) => (
            StatusCode::CONFLICT,
            "entry_conflict",
            "someone saved these days after you read them",
            json!({ "conflicts": conflicts }),
        ),
        ScheduleStoreError::CellsRefused(refused) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "cells_refused",
            "cells that cannot be saved were sent; nothing was saved",
            json!({ "refused": refused }),
        ),
        other => return RestError::schedule(other),
    };
    let mut error = RestError::new(status, code, message);
    error.details = Some(details);
    error
}

type Written = Result<(StatusCode, Json<SaveReceipt>), RestError>;

fn written((v, fresh): (SaveReceipt, bool)) -> (StatusCode, Json<SaveReceipt>) {
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
pub(crate) struct DaysQuery {
    date: String,
    workplace_id: Option<Uuid>,
    unit_id: Option<Uuid>,
    issues_only: Option<bool>,
}

async fn days(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<DaysQuery>,
) -> Result<Json<DayBoard>, RestError> {
    let c = caller(&principal(&s, &h).await?, READ)?;
    let query = BoardQuery {
        date: Some(parse_date(&q.date, "date")?),
        workplace_id: q.workplace_id,
        unit_id: q.unit_id,
        issues_only: q.issues_only.unwrap_or(false),
    };
    Ok(Json(
        s.store
            .day_board(&c, query)
            .await
            .map_err(RestError::schedule)?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MonthQuery {
    month: String,
    workplace_id: Option<Uuid>,
    unit_id: Option<Uuid>,
    cursor: Option<Uuid>,
    limit: Option<usize>,
}

async fn month(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<MonthQuery>,
) -> Result<Json<MonthGrid>, RestError> {
    let c = caller(&principal(&s, &h).await?, READ)?;
    let query = GridQuery {
        month: q.month,
        workplace_id: q.workplace_id,
        unit_id: q.unit_id,
        cursor: q.cursor,
        limit: q.limit.unwrap_or(100),
    };
    Ok(Json(
        s.store
            .month_grid(&c, query)
            .await
            .map_err(RestError::schedule)?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PersonMonthQuery {
    month: String,
}

async fn person_month(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    AttendanceQuery(q): AttendanceQuery<PersonMonthQuery>,
) -> Result<Json<PersonMonth>, RestError> {
    let c = caller(&principal(&s, &h).await?, READ)?;
    Ok(Json(
        s.store
            .person_month(&c, id, q.month)
            .await
            .map_err(RestError::schedule)?,
    ))
}

async fn preview(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Body(b): Body<PreviewInput>,
) -> Result<Json<SavePreview>, RestError> {
    let p = principal(&s, &h).await?;
    let c = caller(&p, WRITE)?;
    let preview = s
        .store
        .preview_entries(&c, b)
        .await
        .map_err(RestError::schedule)?;
    for code in preview
        .cells
        .iter()
        .filter(|c| c.status == "REFUSED")
        .filter_map(|c| c.code)
        .collect::<std::collections::BTreeSet<_>>()
    {
        audit::record(&s, &p, code).await?;
    }
    Ok(Json(preview))
}

async fn save(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Body(b): Body<SaveInput>,
) -> Written {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    let key = idempotency(&h)?;
    Ok(written(
        s.store.save_entries(&c, &key, b).await.map_err(refused)?,
    ))
}

async fn undo(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Body(b): Body<UndoInput>,
) -> Result<Json<SaveReceipt>, RestError> {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    Ok(Json(
        s.store
            .undo_batch(&c, id, b)
            .await
            .map_err(RestError::schedule)?,
    ))
}

async fn correct(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Body(b): Body<CorrectInput>,
) -> Written {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    let key = idempotency(&h)?;
    Ok(written(
        s.store
            .correct_entry(&c, &key, id, b)
            .await
            .map_err(refused)?,
    ))
}

async fn void(
    State(s): State<AttendanceRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Body(b): Body<VoidInput>,
) -> Written {
    let c = caller(&principal(&s, &h).await?, WRITE)?;
    let key = idempotency(&h)?;
    Ok(written(
        s.store.void_entry(&c, &key, id, b).await.map_err(refused)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::{IntoResponse, Response};
    use console_attendance_application::records_read::{CellPreview, Conflict};
    use time::macros::date;

    async fn body(r: Response) -> (StatusCode, serde_json::Value) {
        let status = r.status();
        let bytes = axum::body::to_bytes(r.into_body(), 1 << 16).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn rows_of_a_refusal_ride_under_error_details() {
        let conflict = Conflict {
            employee_id: Uuid::nil(),
            work_date: date!(2026 - 10 - 06),
            base_entry_id: None,
            current: None,
            mine: "9-18".into(),
        };
        let (status, v) =
            body(refused(ScheduleStoreError::EntryConflict(vec![conflict])).into_response()).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(v["error"]["code"], "entry_conflict");
        assert_eq!(v["error"]["details"]["conflicts"][0]["mine"], "9-18");
        assert!(v.get("conflicts").is_none());

        let cell = CellPreview {
            long_span_minutes: Some(960),
            employee_id: Uuid::nil(),
            work_date: date!(2026 - 10 - 06),
            status: "REFUSED",
            code: Some("overtime_typed"),
            after: None,
        };
        let (status, v) =
            body(refused(ScheduleStoreError::CellsRefused(vec![cell])).into_response()).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(v["error"]["code"], "cells_refused");
        assert_eq!(
            v["error"]["details"]["refused"][0]["code"],
            "overtime_typed"
        );
        assert!(v.get("refused").is_none());
    }
}
