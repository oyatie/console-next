// SPDX-License-Identifier: LicenseRef-Proprietary
//! Recorded, unannounced events available to a 발령 공고 composer.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use sqlx::Row;
use uuid::Uuid;

use super::AppointmentNoticeListQuery;
use crate::authz::authorize_hr_org_wide;
use crate::lifecycle::events_page::encode_events_cursor;
use crate::lifecycle::rows::employee_lifecycle_event_from_row;
use crate::lifecycle::types::EmployeeLifecycleEventResponse;
use crate::{HrError, HrService, lifecycle_event_select};

#[derive(Debug, Serialize)]
pub struct AppointmentNoticeCandidate {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub name: String,
    pub event: EmployeeLifecycleEventResponse,
}

#[derive(Debug, Serialize)]
pub struct AppointmentNoticeCandidatePage {
    pub items: Vec<AppointmentNoticeCandidate>,
    pub next_cursor: Option<String>,
}

impl HrService {
    pub async fn appointment_notice_candidates(
        &self,
        principal: Principal,
        query: AppointmentNoticeListQuery,
    ) -> Result<AppointmentNoticeCandidatePage, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let page = query.page()?;
        let org = *principal.org_id.as_uuid();
        let rows = with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(concat!(
                    "SELECT c.*, e.name, e.employee_number FROM (",
                    lifecycle_event_select!(
                        "WHERE l.org_id = $1 AND l.state IN ('APPLIED', 'SCHEDULED') \
                         AND l.event_type NOT IN ('RESCIND', 'EXIT_REVERSAL') \
                         AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v \
                             WHERE v.org_id = l.org_id AND v.voids_event_id = l.id) \
                         AND NOT EXISTS (SELECT 1 FROM appointment_notice_lines n \
                             WHERE n.org_id = l.org_id AND n.lifecycle_event_id = l.id) \
                         AND ($2::timestamptz IS NULL OR (l.created_at, l.id) < ($2, $3)) \
                         ORDER BY l.created_at DESC, l.id DESC LIMIT $4"
                    ),
                    ") c JOIN person_employees_current e ON e.org_id = $1 AND e.id = c.employee_id \
                     ORDER BY c.created_at DESC, c.id DESC"
                ))
                .bind(org)
                .bind(page.before.map(|(at, _)| at))
                .bind(page.before.map(|(_, id)| id))
                .bind(page.limit + 1)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;
        let mut items = rows
            .into_iter()
            .map(|row| {
                let name = row.try_get("name")?;
                let employee_number = row.try_get("employee_number")?;
                let event = employee_lifecycle_event_from_row(row)?;
                Ok(AppointmentNoticeCandidate {
                    employee_id: event.employee_id,
                    employee_number,
                    name,
                    event,
                })
            })
            .collect::<Result<Vec<_>, HrError>>()?;
        let limit = usize::try_from(page.limit).unwrap_or(1);
        let next_cursor = if items.len() > limit {
            items.truncate(limit);
            items
                .last()
                .map(|last| encode_events_cursor(last.event.created_at, last.event.id))
        } else {
            None
        };
        Ok(AppointmentNoticeCandidatePage { items, next_cursor })
    }
}
