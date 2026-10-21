//! Reading 발령 공고: the list (keyset, newest first) and one notice with its
//! lines as render data.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use sqlx::{Postgres, QueryBuilder, Row, Transaction};
use uuid::Uuid;

use super::{
    AppointmentNotice, AppointmentNoticeLine, AppointmentNoticeListQuery, AppointmentNoticePage,
    AppointmentNoticeSummary,
};
use crate::authz::{HrReach, hr_reach, out_of_scope, push_reach};

use crate::lifecycle::events_page::encode_events_cursor;
use crate::lifecycle::rows::employee_lifecycle_event_from_row;
use crate::{HrError, HrService, lifecycle_event_select};

/// `NOT EXISTS (a line of notice n naming someone outside reach)`.
fn push_all_lines_in_reach(q: &mut QueryBuilder<Postgres>, reach: &HrReach) {
    if *reach == HrReach::All {
        q.push(" TRUE ");
        return;
    }
    q.push(
        " NOT EXISTS (SELECT 1 FROM appointment_notice_lines x \
           JOIN employee_lifecycle_events l ON l.org_id = x.org_id AND l.id = x.lifecycle_event_id \
           JOIN employees e ON e.org_id = l.org_id AND e.id = l.employee_id",
    );
    q.push(crate::assignment_lateral!());
    q.push(" WHERE x.org_id = n.org_id AND x.notice_id = n.id AND NOT ");
    push_reach(q, reach);
    q.push(") ");
}
/// Whether notice `id` exists with every line inside `reach`.
async fn notice_in_reach(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
    reach: &HrReach,
) -> Result<bool, HrError> {
    let mut q = QueryBuilder::<Postgres>::new(
        "SELECT EXISTS (SELECT 1 FROM appointment_notices n WHERE n.id = ",
    );
    q.push_bind(id);
    q.push(" AND ");
    push_all_lines_in_reach(&mut q, reach);
    q.push(")");
    Ok(q.build_query_scalar().fetch_one(tx.as_mut()).await?)
}

const SUMMARY: &str = "SELECT n.id, n.notice_no, n.title, n.notice_date::TEXT AS notice_date, \
     n.issued_by, u.display_name AS issued_by_name, n.issued_at, n.note, \
     (SELECT count(*) FROM appointment_notice_lines x WHERE x.org_id = n.org_id AND x.notice_id = n.id) AS line_count \
     FROM appointment_notices n LEFT JOIN users u ON u.id = n.issued_by ";

fn summary(row: &sqlx::postgres::PgRow) -> Result<AppointmentNoticeSummary, HrError> {
    Ok(AppointmentNoticeSummary {
        id: row.try_get("id")?,
        notice_no: row.try_get("notice_no")?,
        title: row.try_get("title")?,
        notice_date: row.try_get("notice_date")?,
        issued_by: row.try_get("issued_by")?,
        issued_by_name: row.try_get("issued_by_name")?,
        issued_at: row.try_get("issued_at")?,
        line_count: row.try_get("line_count")?,
    })
}

/// One notice with its lines; `manager` false redacts each event as the
/// lifecycle history does for a reader.
pub(super) async fn load_notice(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    id: Uuid,
    manager: bool,
) -> Result<AppointmentNotice, HrError> {
    let head = sqlx::query(sqlx::AssertSqlSafe(format!(
        "{SUMMARY} WHERE n.org_id = $1 AND n.id = $2"
    )))
    .bind(org)
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| {
        HrError::from_kernel(console_kernel_core::KernelError::not_found(
            "notice not found",
        ))
    })?;
    let events = sqlx::query(lifecycle_event_select!(
        "JOIN appointment_notice_lines x ON x.org_id = l.org_id AND x.lifecycle_event_id = l.id \
         WHERE x.org_id = $1 AND x.notice_id = $2 ORDER BY x.line_no"
    ))
    .bind(org)
    .bind(id)
    .fetch_all(tx.as_mut())
    .await?;
    let people: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT e.id, e.name, e.employee_number FROM employees e \
         JOIN employee_lifecycle_events l ON l.org_id = e.org_id AND l.employee_id = e.id \
         JOIN appointment_notice_lines x ON x.org_id = l.org_id AND x.lifecycle_event_id = l.id \
         WHERE x.org_id = $1 AND x.notice_id = $2",
    )
    .bind(org)
    .bind(id)
    .fetch_all(tx.as_mut())
    .await?;
    let mut lines = Vec::with_capacity(events.len());
    for (n, row) in events.into_iter().enumerate() {
        let event = employee_lifecycle_event_from_row(row)?;
        let event = if manager {
            event
        } else {
            event.redact_for_reader()
        };
        let (name, number) = people
            .iter()
            .find(|p| p.0 == event.employee_id)
            .map(|p| (p.1.clone(), p.2.clone()))
            .unwrap_or_default();
        lines.push(AppointmentNoticeLine {
            line_no: i32::try_from(n + 1).unwrap_or(i32::MAX),
            employee_id: event.employee_id,
            employee_number: number,
            name,
            event,
        });
    }
    Ok(AppointmentNotice {
        summary: summary(&head)?,
        note: head.try_get("note")?,
        lines,
    })
}

impl HrService {
    /// `GET /api/v1/appointment-notices?limit=&cursor=`.
    pub async fn appointment_notices(
        &self,
        principal: Principal,
        query: AppointmentNoticeListQuery,
    ) -> Result<AppointmentNoticePage, HrError> {
        // AX-5: a scoped reader lists the notices whose every line is a
        // person inside its grant set (a notice never names someone outside).
        let reach = hr_reach(&principal, Feature::EmployeeDirectoryRead)?;
        let page = query.page()?;
        let org = *principal.org_id.as_uuid();
        let rows = with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let mut q = QueryBuilder::<Postgres>::new(SUMMARY);
                q.push(" WHERE n.org_id = ");
                q.push_bind(org);
                q.push(" AND (");
                q.push_bind(page.before.map(|(at, _)| at));
                q.push("::timestamptz IS NULL OR (n.issued_at, n.id) < (");
                q.push_bind(page.before.map(|(at, _)| at));
                q.push(", ");
                q.push_bind(page.before.map(|(_, id)| id));
                q.push(")) AND ");
                push_all_lines_in_reach(&mut q, &reach);
                q.push(" ORDER BY n.issued_at DESC, n.id DESC LIMIT ");
                q.push_bind(page.limit + 1);
                Ok(q.build().fetch_all(tx.as_mut()).await?)
            })
        })
        .await?;
        let mut items = rows.iter().map(summary).collect::<Result<Vec<_>, _>>()?;
        let size = usize::try_from(page.limit).unwrap_or(1);
        let next_cursor = (items.len() > size).then(|| {
            items.truncate(size);
            items
                .last()
                .map(|last| encode_events_cursor(last.issued_at, last.id))
        });
        Ok(AppointmentNoticePage {
            items,
            next_cursor: next_cursor.flatten(),
        })
    }

    /// `GET /api/v1/appointment-notices/{id}`.
    pub async fn appointment_notice(
        &self,
        principal: Principal,
        id: Uuid,
    ) -> Result<AppointmentNotice, HrError> {
        let reach = hr_reach(&principal, Feature::EmployeeDirectoryRead)?;
        let manage = hr_reach(&principal, Feature::EmployeeDirectoryManage).ok();
        let org = *principal.org_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                // AX-5: every line inside the grant set, or `out_of_scope`
                // (the same answer as no such notice).
                if reach != HrReach::All && !notice_in_reach(tx, id, &reach).await? {
                    return Err(out_of_scope(&principal, Feature::EmployeeDirectoryRead));
                }
                let manager = match &manage {
                    Some(HrReach::All) => true,
                    Some(reach) => notice_in_reach(tx, id, reach).await?,
                    None => false,
                };
                load_notice(tx, org, id, manager).await
            })
        })
        .await
    }
}
