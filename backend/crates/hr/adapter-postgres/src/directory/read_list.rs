//! `GET /employees`: the page read and the row mapping shared with the detail
//! read (moved from `app/src/hr.rs`, R2-people).

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::authz::{Tier, hr_reach_in};
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::directory::read_sort::{RosterCursor, RosterPaging};
use crate::directory::types::{
    EmployeeFailedEvent, EmployeeNextEvent, EmployeePage, EmployeeResponse,
};
use crate::metrics::record_hr_read;
use crate::paging::{DEFAULT_LIMIT, MAX_LIMIT};
use crate::{HrError, HrService};

pub use crate::directory::read_filters::{
    EmployeeListFilters, EmployeeListQuery, MAX_EMPLOYEE_NUMBERS, counted_employees,
    filtered_employees,
};

pub fn employee_from_row(row: sqlx::postgres::PgRow) -> Result<EmployeeResponse, HrError> {
    Ok(EmployeeResponse {
        id: row.try_get("id")?,
        person_id: row.try_get("person_id")?,
        company: row.try_get("company")?,
        name: row.try_get("name")?,
        employee_number: row.try_get("employee_number")?,
        org_unit: row.try_get("org_unit")?,
        org_unit_id: row.try_get("org_unit_id")?,
        legal_entity_id: row.try_get("legal_entity_id")?,
        workplace_id: row.try_get("workplace_id")?,
        worksite_name: row.try_get("worksite_name")?,
        worksite: row.try_get("worksite_address")?,
        job: row.try_get("job")?,
        position: row.try_get("position")?,
        hire_date: row.try_get("hire_date")?,
        exit_date: row.try_get("exit_date")?,
        status: row.try_get("employment_status")?,
        status_since: row.try_get("status_since")?,
        leave_accrued: row.try_get("leave_accrued")?,
        leave_used: row.try_get("leave_used")?,
        leave_remaining: row.try_get("leave_remaining")?,
        home_branch_id: row.try_get("home_branch_id")?,
        home_branch_name: row.try_get("home_branch_name")?,
        home_branch_review_required: row.try_get::<Option<Uuid>, _>("home_branch_id")?.is_none(),
        register_review_required: row.try_get("register_review_required")?,
        identity_resolution_strategy: row.try_get("identity_resolution_strategy")?,
        identity_resolution_confidence: row.try_get("identity_resolution_confidence")?,
        identity_review_required: row.try_get("identity_review_required")?,
        identity_name_only_merge: row.try_get("identity_name_only_merge")?,
        contract_end_date: row.try_get("contract_end_date")?,
        employment_type: row.try_get("employment_type")?,
        expected_return_date: row.try_get("expected_return_date")?,
        work_email: row.try_get("work_email")?,
        next_event: match row.try_get::<Option<Uuid>, _>("next_event_id")? {
            Some(id) => Some(EmployeeNextEvent {
                id,
                event_type: row.try_get("next_event_type")?,
                effective_date: row.try_get("next_event_date")?,
            }),
            None => None,
        },
        failed_event: match row.try_get::<Option<Uuid>, _>("failed_event_id")? {
            Some(id) => Some(EmployeeFailedEvent {
                id,
                event_type: row.try_get("failed_event_type")?,
                effective_date: row.try_get("failed_event_date")?,
                failure_code: row.try_get("failed_event_code")?,
            }),
            None => None,
        },
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// The columns [`employee_from_row`] decodes.
pub const EMPLOYEE_ROW_SELECT: &str = concat!(
    "SELECT e.id, e.company, COALESCE(console_employee_facts(e.org_id,e.id)->>'legal_name',e.name) AS name, console_employee_person(e.org_id,e.id) AS person_id, e.employee_number, e.org_unit, e.org_unit_id, e.job, e.position, e.worksite_name, e.worksite_address, to_char(e.hire_on, 'YYYY-MM-DD') AS hire_date, to_char(e.exit_on, 'YYYY-MM-DD') AS exit_date, e.employment_status, e.leave_accrued::TEXT AS leave_accrued, e.leave_used::TEXT AS leave_used, e.leave_remaining::TEXT AS leave_remaining, b.id AS home_branch_id, b.name AS home_branch_name, e.identity_resolution_strategy, e.identity_resolution_confidence, ",
    crate::identity_review_sql!(),
    " AS identity_review_required, e.identity_name_only_merge, e.work_email, e.created_at, e.updated_at, ea.legal_entity_id, ea.workplace_id, p.contract_end_date::TEXT AS contract_end_date, p.employment_type, lr.expected_return_date, ss.status_since, ne.id AS next_event_id, ne.event_type AS next_event_type, ne.effective_date AS next_event_date, fe.id AS failed_event_id, fe.event_type AS failed_event_type, fe.effective_date AS failed_event_date, fe.failure_code AS failed_event_code",
    ", ",
    crate::register_review_sql!(),
    " AS register_review_required"
);

impl HrService {
    pub async fn list_employees(
        &self,
        principal: Principal,
        query: EmployeeListQuery,
    ) -> Result<EmployeePage, HrError> {
        // AX-5: the reader sees the people inside its grant set (a legacy
        // branch role, the people homed in its branches).
        let reach = hr_reach_in(&principal, Feature::EmployeeDirectoryRead, Tier::Branch)?;
        record_hr_read("employees");
        let org = principal.org_id;
        let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let paging =
            RosterPaging::from_query(query.sort.as_deref(), query.cursor.as_deref(), query.offset)?;
        let offset = match paging {
            RosterPaging::Offset(offset) => offset,
            RosterPaging::Keyset { .. } => 0,
        };
        let filters =
            EmployeeListFilters::from_query(&query, &principal.branch_scope)?.with_reach(reach);

        let (items, total, next_cursor) = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
        Box::pin(async move {
            let total: i64 = counted_employees("SELECT count(*)", &filters)
                .build_query_scalar()
                .fetch_one(tx.as_mut())
                .await?;

            let (mut rows, keyset) = match &paging {
                RosterPaging::Offset(offset) => {
                    let mut rows = filtered_employees(EMPLOYEE_ROW_SELECT, &filters);
                    rows.push(" ORDER BY e.company ASC, COALESCE(console_employee_facts(e.org_id,e.id)->>'legal_name',e.name) ASC, e.source_sheet ASC, e.source_row ASC LIMIT ");
                    rows.push_bind(limit);
                    rows.push(" OFFSET ");
                    rows.push_bind(*offset);
                    (rows.build().fetch_all(tx.as_mut()).await?, None)
                }
                RosterPaging::Keyset { sort, after } => {
                    let select = format!("{EMPLOYEE_ROW_SELECT}, {} AS sort_value", sort.expr());
                    let mut rows = filtered_employees(&select, &filters);
                    if let Some(after) = after {
                        sort.push_after(&mut rows, after);
                    }
                    sort.push_order(&mut rows);
                    // One extra row tells whether a next page exists.
                    rows.push(" LIMIT ");
                    rows.push_bind(limit + 1);
                    (rows.build().fetch_all(tx.as_mut()).await?, Some(*sort))
                }
            };
            let page_rows = usize::try_from(limit).unwrap_or(1);
            let next_cursor = match keyset {
                Some(sort) if rows.len() > page_rows => {
                    rows.truncate(page_rows);
                    let last = rows.last().ok_or_else(|| HrError::internal("empty keyset page"))?;
                    Some(RosterCursor { sort, value: last.try_get("sort_value")?, id: last.try_get("id")? }.encode())
                }
                _ => None,
            };
            let items = rows
                .into_iter()
                .map(employee_from_row)
                .collect::<Result<Vec<_>, _>>()?;
            let subjects = items.iter().map(|item| item.id).collect::<Vec<_>>();
            let me = actor_employee_id(tx, &principal).await?;
            let event = access_event(&principal, DirectoryAccess::List, &subjects, me, json!({}))?;
            Ok(((items, total, next_cursor), vec![event]))
        })
    })
    .await?;

        Ok(EmployeePage {
            items,
            total,
            limit,
            offset,
            next_cursor,
        })
    }
}
