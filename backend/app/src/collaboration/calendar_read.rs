// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub(super) struct CalendarCursor {
    #[serde(with = "time::serde::rfc3339")]
    as_of: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    starts_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    id: Uuid,
}

pub(super) async fn list_calendar_events(
    State(state): State<CollaborationState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<CalendarEventQuery>,
) -> Result<Json<CalendarEventListResponse>, CollaborationError> {
    let limit = normalize_limit(query.limit);
    let now = OffsetDateTime::now_utc();
    let cursor: Option<CalendarCursor> = query
        .cursor
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| CollaborationError::validation("invalid calendar cursor"))?;
    let as_of = cursor.map_or(now, |page| page.as_of);
    if as_of > now {
        return Err(CollaborationError::validation("invalid calendar page"));
    }
    let from = query
        .from
        .unwrap_or_else(|| as_of - time::Duration::days(1));
    let to = query.to.unwrap_or_else(|| as_of + time::Duration::days(14));
    if to < from {
        return Err(CollaborationError::validation(
            "calendar query end must be after start",
        ));
    }
    let snapshot = collect_calendar_events(
        &state.pool,
        &principal,
        from,
        to,
        (limit, cursor),
        as_of,
        false,
    )
    .await?;
    record_collaboration_request("calendar_list", "success");
    Ok(Json(CalendarEventListResponse {
        next_cursor: snapshot
            .items
            .last()
            .filter(|_| snapshot.items.len() < snapshot.total)
            .map(|last| {
                serde_json::to_string(&CalendarCursor {
                    as_of,
                    starts_at: last.starts_at,
                    created_at: last.created_at,
                    id: last.id,
                })
            })
            .transpose()
            .map_err(|_| CollaborationError::internal("cannot encode calendar cursor"))?,
        items: snapshot.items,
    }))
}

pub(super) struct CalendarEventSnapshot {
    pub(super) items: Vec<CalendarEventResponse>,
    pub(super) total: usize,
    pub(super) as_of: OffsetDateTime,
}

pub(super) async fn collect_calendar_events(
    pool: &PgPool,
    principal: &Principal,
    from: OffsetDateTime,
    to: OffsetDateTime,
    page: (i64, Option<CalendarCursor>),
    as_of: OffsetDateTime,
    half_open_range: bool,
) -> Result<CalendarEventSnapshot, CollaborationError> {
    let (limit, cursor) = page;
    authorize_collaboration_member(principal)?;
    let org = principal.org_id;
    let user_ref = principal.user_id.as_uuid().to_string();
    let user_id = *principal.user_id.as_uuid();
    let (branch_all, branch_refs) = audience_branch_binds(principal);
    let audience = scope_visibility_sql(
        "scope_type",
        "scope_ref",
        "created_by",
        "$3",
        "$4",
        "$8",
        "$9",
    );
    let sql = format!(
        "SELECT id, scope_type, scope_ref, title, description, starts_at, ends_at, \
                all_day, status, object_type, object_id, created_by, created_at, updated_at, \
                COUNT(*) OVER() AS snapshot_total \
         FROM collaboration_calendar_events \
         WHERE status = 'ACTIVE' \
           AND ( \
               ($7 AND starts_at < $1 AND ends_at > $2) \
               OR (NOT $7 AND starts_at <= $1 AND ends_at >= $2) \
           ) \
           AND {audience} \
           AND created_at <= $5 \
           AND updated_at <= $5 \
           AND ($10::timestamptz IS NULL OR starts_at > $10 OR (starts_at = $10 AND created_at < $11) \
                OR (starts_at = $10 AND created_at = $11 AND id > $12)) \
         ORDER BY starts_at ASC, created_at DESC, id ASC \
         LIMIT $6"
    );
    let rows = with_org_conn::<_, _, CollaborationError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(to)
                .bind(from)
                .bind(user_ref)
                .bind(user_id)
                .bind(as_of)
                .bind(limit)
                .bind(half_open_range)
                .bind(branch_all)
                .bind(&branch_refs)
                .bind(cursor.map(|page| page.starts_at))
                .bind(cursor.map(|page| page.created_at))
                .bind(cursor.map(|page| page.id))
                .fetch_all(tx.as_mut())
                .await?)
        })
    })
    .await?;
    let total = rows
        .first()
        .map(|row| row.try_get::<i64, _>("snapshot_total"))
        .transpose()?
        .unwrap_or(0);
    let total = usize::try_from(total)
        .map_err(|_| CollaborationError::internal("calendar count exceeded supported range"))?;
    let items = rows
        .into_iter()
        .map(calendar_event_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CalendarEventSnapshot {
        items,
        total,
        as_of,
    })
}

/// Native calendar-owner adapter for the workbench aggregate. It reuses the
/// authenticated collaboration visibility predicate, applies the aggregate's
/// exact half-open range and one request ceiling, and never persists a second
/// calendar projection.
pub(crate) async fn read_workbench_calendar(
    pool: &PgPool,
    principal: &Principal,
    range: crate::workbench::WorkbenchRange,
    limit: usize,
    as_of: OffsetDateTime,
) -> Result<crate::workbench::CalendarPage, crate::workbench::SourceFailure> {
    match console_platform_request_context::tenant_module::TenantModule::Calendar
        .enabled(pool, principal.org_id)
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            return Err(crate::workbench::SourceFailure::Denied {
                code: "module_disabled",
            });
        }
        Err(_) => {
            return Err(crate::workbench::SourceFailure::Unavailable {
                code: "calendar_unavailable",
            });
        }
    }
    let limit = i64::try_from(limit).map_err(|_| crate::workbench::SourceFailure::Unavailable {
        code: "calendar_limit_invalid",
    })?;
    let snapshot = collect_calendar_events(
        pool,
        principal,
        range.from,
        range.to,
        (limit, None),
        as_of,
        true,
    )
    .await
    .map_err(|error| {
        if error.status == StatusCode::FORBIDDEN {
            crate::workbench::SourceFailure::Denied {
                code: "calendar_access_denied",
            }
        } else {
            crate::workbench::SourceFailure::Unavailable {
                code: "calendar_unavailable",
            }
        }
    })?;
    let items = snapshot
        .items
        .into_iter()
        .map(|item| crate::workbench::CalendarItem {
            id: item.id,
            title: item.title,
            starts_at: item.starts_at,
            ends_at: item.ends_at,
            target: crate::workbench::WorkbenchTarget {
                module: "overview".to_owned(),
                id: item.id.to_string(),
            },
        })
        .collect();
    Ok(crate::workbench::CalendarPage {
        as_of: snapshot.as_of,
        total: snapshot.total,
        items,
    })
}
