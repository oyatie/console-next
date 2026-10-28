// SPDX-License-Identifier: LicenseRef-Proprietary
//! Month close board and its batched access record.
use crate::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CloseListQuery {
    month: String,
    branch_id: Option<Uuid>,
}
pub(crate) async fn list_closes(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    AttendanceQuery(q): AttendanceQuery<CloseListQuery>,
) -> Result<Json<MonthCloseBoardDto>, RestError> {
    let p = principal(&state, &headers).await?;
    require_for_branch(&p, READ, q.branch_id)?;
    record_read("closes");
    let month = AttendanceDateRange::selected_month_with_buffer(&q.month)
        .map_err(|error| {
            RestError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                error.to_string(),
            )
        })?
        .from;
    let preflight = state
        .store
        .close_checks(
            &scope(&p),
            &CloseMonth {
                month: q.month.clone(),
                branch_scope: q.branch_id,
                attest: false,
            },
        )
        .await
        .map_err(RestError::store)?;
    let closes = state
        .store
        .list_closes(&scope(&p), q.branch_id, month)
        .await
        .map_err(RestError::store)?;
    let mut subjects: Vec<_> = closes
        .iter()
        .flat_map(|close| {
            std::iter::once(close.attested_by).chain(close.amendments.iter().map(|a| a.actor))
        })
        .collect();
    subjects.sort_unstable();
    subjects.dedup();
    audit::read_record(
        &state,
        &p,
        console_platform_request_context::audit_context::access_log::AccessRecord {
            action: "attendance.closes_read",
            target_type: "attendance_month_close",
            target_id: q.month.clone(),
            subject_ids: &[],
            reader_subject: None,
            details: serde_json::json!({}),
        },
        &subjects,
    )
    .await?;
    let open = |checks: &[console_attendance_application::CloseCheckRead],
                key: &str|
     -> Result<i64, RestError> {
        checks
            .iter()
            .find(|check| check.key == key)
            .and_then(|check| check.note.as_deref())
            .and_then(|note| note.parse().ok())
            .ok_or_else(|| {
                RestError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "close checks are invalid",
                )
            })
    };
    let items = if closes.is_empty() {
        vec![MonthCloseItemDto {
            branch_scope: q
                .branch_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "org".into()),
            closed: false,
            close: None,
            open_exceptions: open(&preflight.checks, "open_exceptions")?,
            pending_leave: open(&preflight.checks, "pending_leave")?,
        }]
    } else {
        closes
            .into_iter()
            .map(|close| {
                let open_exceptions = open(&close.checks, "open_exceptions")?;
                let pending_leave = open(&close.checks, "pending_leave")?;
                Ok(MonthCloseItemDto {
                    branch_scope: close
                        .branch_id
                        .map(|id| id.to_string())
                        .unwrap_or_else(|| "org".into()),
                    closed: true,
                    close: Some(MonthCloseDto::from(close)),
                    open_exceptions,
                    pending_leave,
                })
            })
            .collect::<Result<Vec<_>, RestError>>()?
    };
    Ok(Json(MonthCloseBoardDto {
        month: q.month,
        items,
    }))
}
