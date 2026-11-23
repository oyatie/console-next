// SPDX-License-Identifier: LicenseRef-Proprietary
//! Set-based transaction preloads for `POST /api/v1/hr/exit-cases/bulk`.

use std::collections::{HashMap, HashSet};

use console_kernel_core::{OrgId, UserId};
use console_platform_authz::{
    Feature, Principal,
    cedar_pbac::visible::{DecisionFacts, load_facts},
};
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::authz::{HrCaseFacts, holds_scoped};
use crate::exits::bulk_report::BulkExitCaseItemInput;
use crate::own_record::{OwnRecord, own_record_decisions_many};

pub(crate) struct BulkPreload {
    pub(crate) scoped: bool,
    pub(crate) employees: HashMap<Uuid, (Option<Uuid>, String, Option<String>)>,
    pub(crate) alerts: HashMap<(Uuid, Uuid), Option<Uuid>>,
    pub(crate) attendance_branches: HashMap<Uuid, Option<Uuid>>,
    pub(crate) open_cases: HashSet<Uuid>,
    pub(crate) scheduled_terminates: HashSet<Uuid>,
    pub(crate) case_facts: Option<HrCaseFacts>,
    pub(crate) access: Option<DecisionFacts>,
    pub(crate) own_decisions: HashMap<Uuid, OwnRecord>,
}

pub(crate) async fn load_bulk_preload(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    principal: &Principal,
    org: OrgId,
    actor: UserId,
    items: &[BulkExitCaseItemInput],
) -> Result<BulkPreload, HrError> {
    let org_uuid = *org.as_uuid();
    let scoped = holds_scoped(principal, Feature::ExitCaseReport);
    let mut emp_ids: Vec<Uuid> = items.iter().map(|i| i.employee_id).collect();
    emp_ids.sort_unstable();
    emp_ids.dedup();
    let alert_ids: Vec<Uuid> = items.iter().filter_map(|i| i.absence_alert_id).collect();

    let emp_rows: Vec<(Uuid, Option<Uuid>, String, Option<String>)> = sqlx::query_as(
        "SELECT id, home_branch_id, employment_status, hire_date \
         FROM employees WHERE org_id = $1 AND id = ANY($2) FOR SHARE",
    )
    .bind(org_uuid)
    .bind(&emp_ids)
    .fetch_all(tx.as_mut())
    .await?;
    let employees = emp_rows
        .into_iter()
        .map(|(id, branch, status, hire)| (id, (branch, status, hire)))
        .collect();

    let alert_rows: Vec<(Uuid, Uuid, Option<Uuid>)> = if alert_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "SELECT id, employee_id, branch_id FROM employee_absence_alerts \
             WHERE org_id = $1 AND id = ANY($2) FOR UPDATE",
        )
        .bind(org_uuid)
        .bind(&alert_ids)
        .fetch_all(tx.as_mut())
        .await?
    };
    let alerts = alert_rows
        .into_iter()
        .map(|(id, emp_id, branch)| ((id, emp_id), branch))
        .collect();

    let att_rows: Vec<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT DISTINCT ON (employee_id) employee_id, branch_id \
         FROM attendance_direct_import_events \
         WHERE org_id = $1 AND employee_id = ANY($2) \
         ORDER BY employee_id, work_date DESC, created_at DESC, id DESC",
    )
    .bind(org_uuid)
    .bind(&emp_ids)
    .fetch_all(tx.as_mut())
    .await?;
    let attendance_branches = att_rows.into_iter().collect();

    let open_cases = sqlx::query_scalar::<_, Uuid>(
        "SELECT employee_id FROM employee_exit_cases \
         WHERE org_id = $1 AND employee_id = ANY($2) \
           AND status NOT IN ('REJECTED','CANCELLED','SUBMITTED')",
    )
    .bind(org_uuid)
    .bind(&emp_ids)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .collect();

    let scheduled_terminates = sqlx::query_scalar::<_, Uuid>(
        "SELECT DISTINCT employee_id FROM employee_lifecycle_events \
         WHERE org_id = $1 AND employee_id = ANY($2) \
           AND event_type = 'TERMINATE' AND state = 'SCHEDULED'",
    )
    .bind(org_uuid)
    .bind(&emp_ids)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .collect();

    let case_facts = if scoped {
        Some(HrCaseFacts::load(tx, *actor.as_uuid(), &emp_ids).await?)
    } else {
        None
    };
    let access = if scoped {
        Some(
            load_facts(tx, org, *actor.as_uuid())
                .await
                .map_err(HrError::from_kernel)?,
        )
    } else {
        None
    };
    let own_decisions =
        own_record_decisions_many(tx, org, actor, &emp_ids, Feature::ExitCaseReport).await?;

    Ok(BulkPreload {
        scoped,
        employees,
        alerts,
        attendance_branches,
        open_cases,
        scheduled_terminates,
        case_facts,
        access,
        own_decisions,
    })
}
