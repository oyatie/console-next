// SPDX-License-Identifier: LicenseRef-Proprietary
//! `GET /api/v1/employees/{id}/unit-position`: server-computed position of an
//! employee inside their org unit (supporting J/K navigation past 200 members).

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::Serialize;
use serde_json::json;
use sqlx::{Postgres, QueryBuilder, Row};
use uuid::Uuid;

use crate::authz::{Tier, authorize_hr_person_in, hr_reach_in};
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::directory::read_filters::{push_within, visibility};
use crate::metrics::record_hr_read;
use crate::{HrError, HrService};

#[derive(Debug, Serialize)]
pub struct EmployeeUnitPosition {
    pub org_unit_id: Option<Uuid>,
    pub index: i64,
    pub total: i64,
    pub prev_id: Option<Uuid>,
    pub next_id: Option<Uuid>,
    pub pre_hire_count: i64,
}

impl HrService {
    pub async fn employee_unit_position(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<EmployeeUnitPosition, HrError> {
        let reach = hr_reach_in(&principal, Feature::EmployeeDirectoryRead, Tier::Branch)?;
        record_hr_read("employee_unit_position");
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let reader = principal.clone();

        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person_in(
                    tx,
                    &reader,
                    Feature::EmployeeDirectoryRead,
                    employee_id,
                    Tier::Branch,
                )
                .await?;

                let org_unit_id: Option<Uuid> = sqlx::query_scalar::<_, Option<Uuid>>(
                    "SELECT org_unit_id FROM person_employees_current WHERE org_id = $1 AND id = $2",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| {
                    HrError::from_kernel(console_kernel_core::KernelError::not_found(
                        "employee was not found in this organization",
                    ))
                })?;

                let position = if let Some(unit_id) = org_unit_id {
                    let vis = visibility(tx, &reader, Feature::EmployeeDirectoryRead).await?;
                    let mut q = QueryBuilder::<Postgres>::new(concat!(
                        "WITH ordered AS ( \
                           SELECT e.id, \
                             entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AS status, \
                             ROW_NUMBER() OVER (ORDER BY e.company ASC, COALESCE(console_employee_facts(e.org_id, e.id)->>'legal_name', e.name) ASC, e.source_sheet ASC, e.source_row ASC, e.id ASC) AS idx, \
                             LAG(e.id) OVER (ORDER BY e.company ASC, COALESCE(console_employee_facts(e.org_id, e.id)->>'legal_name', e.name) ASC, e.source_sheet ASC, e.source_row ASC, e.id ASC) AS prev_id, \
                             LEAD(e.id) OVER (ORDER BY e.company ASC, COALESCE(console_employee_facts(e.org_id, e.id)->>'legal_name', e.name) ASC, e.source_sheet ASC, e.source_row ASC, e.id ASC) AS next_id \
                           FROM person_employees_current e",
                        crate::assignment_lateral!(),
                        " WHERE e.org_id = "
                    ));
                    q.push_bind(org_uuid);
                    q.push(" AND (e.org_unit_id = ");
                    q.push_bind(unit_id);
                    q.push(" OR e.org_unit = ");
                    q.push_bind(unit_id);
                    q.push(
                        "::text) AND entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) IN ('ACTIVE', 'ON_LEAVE', 'PRE_HIRE') AND ",
                    );
                    push_within(&mut q, &reach, &vis);
                    q.push(") SELECT (SELECT idx FROM ordered WHERE id = ");
                    q.push_bind(employee_id);
                    q.push(") AS idx, (SELECT prev_id FROM ordered WHERE id = ");
                    q.push_bind(employee_id);
                    q.push(") AS prev_id, (SELECT next_id FROM ordered WHERE id = ");
                    q.push_bind(employee_id);
                    q.push(") AS next_id, COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE status = 'PRE_HIRE')::bigint AS pre_hire_count FROM ordered");

                    let row = q.build().fetch_one(tx.as_mut()).await?;
                    let idx: Option<i64> = row.try_get("idx")?;
                    EmployeeUnitPosition {
                        org_unit_id: Some(unit_id),
                        index: idx.unwrap_or(0),
                        total: row.try_get("total")?,
                        prev_id: row.try_get("prev_id")?,
                        next_id: row.try_get("next_id")?,
                        pre_hire_count: row.try_get("pre_hire_count")?,
                    }
                } else {
                    EmployeeUnitPosition {
                        org_unit_id: None,
                        index: 0,
                        total: 0,
                        prev_id: None,
                        next_id: None,
                        pre_hire_count: 0,
                    }
                };

                let me = actor_employee_id(tx, &reader).await?;
                let event = access_event(
                    &reader,
                    DirectoryAccess::Detail,
                    &[employee_id],
                    me,
                    json!({ "view": "unit_position" }),
                )?;
                Ok((position, vec![event]))
            })
        })
        .await
    }
}
