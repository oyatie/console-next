// SPDX-License-Identifier: LicenseRef-Proprietary
//! Per-item admission evaluation for `POST /api/v1/hr/exit-cases/bulk`.

use std::collections::HashSet;

use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::OrgId;
use console_platform_authz::{Feature, Principal};
use console_settings_domain::code_lists::ValidReason;
use sqlx::Postgres;
use time::Date;
use uuid::Uuid;

use crate::HrError;
use crate::authz::{authorize_hr_scoped_write, out_of_scope};
use crate::exits::bulk_report::{BulkExitCaseItemInput, BulkExitCaseItemResult, fail_item};
use crate::exits::bulk_report_preload::BulkPreload;
use crate::own_record::{OwnRecord, own_record_forbidden};

pub(crate) struct AdmittedItem {
    pub(crate) index: usize,
    pub(crate) case_id: Uuid,
    pub(crate) employee_id: Uuid,
    pub(crate) branch_id: Option<Uuid>,
    pub(crate) requested_branch_id: Option<Uuid>,
    pub(crate) absence_alert_id: Option<Uuid>,
    pub(crate) sole_holder_ops: bool,
}

fn err_result(employee_id: Uuid, code: &str, message: impl Into<String>) -> BulkExitCaseItemResult {
    BulkExitCaseItemResult {
        employee_id,
        ok: false,
        case_id: None,
        code: Some(code.to_owned()),
        message: Some(message.into()),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn evaluate_bulk_items(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    principal: &Principal,
    org: OrgId,
    items: &[BulkExitCaseItemInput],
    effective_exit_date: &str,
    exit_date_parsed: Date,
    exit_reason: Option<&ValidReason>,
    preload: &BulkPreload,
) -> Result<(Vec<Option<BulkExitCaseItemResult>>, Vec<AdmittedItem>), HrError> {
    let mut results: Vec<Option<BulkExitCaseItemResult>> = vec![None; items.len()];
    let mut admitted = Vec::new();
    let mut seen_employees = HashSet::new();
    let mut seen_alerts = HashSet::new();

    for (index, item) in items.iter().enumerate() {
        let Some((emp_branch, status, hire)) = preload.employees.get(&item.employee_id) else {
            let code = if preload.scoped {
                "out_of_scope"
            } else {
                "not_found"
            };
            results[index] = Some(err_result(item.employee_id, code, "employee not found"));
            continue;
        };

        let alert_branch = if let Some(alert_id) = item.absence_alert_id {
            if !seen_alerts.insert(alert_id) {
                results[index] = Some(err_result(
                    item.employee_id,
                    "conflict",
                    "duplicate absence_alert_id in batch",
                ));
                continue;
            }
            let Some(b) = preload.alerts.get(&(alert_id, item.employee_id)) else {
                results[index] = Some(err_result(
                    item.employee_id,
                    "not_found",
                    "absence alert not found for employee",
                ));
                continue;
            };
            *b
        } else {
            None
        };

        let derived_branch = alert_branch.or(*emp_branch).or_else(|| {
            preload
                .attendance_branches
                .get(&item.employee_id)
                .copied()
                .flatten()
        });

        if let Some(req_branch) = item.branch_id
            && derived_branch != Some(req_branch)
        {
            results[index] = Some(err_result(
                item.employee_id,
                "not_found",
                "employee or absence alert was not found in the requested branch",
            ));
            continue;
        }

        let auth_res = if let (Some(cf), Some(acc)) = (&preload.case_facts, &preload.access) {
            if cf.permits(acc, org, item.employee_id, Feature::ExitCaseReport)? {
                Ok(())
            } else {
                Err(out_of_scope(principal, Feature::ExitCaseReport))
            }
        } else {
            authorize_hr_scoped_write(principal, Feature::ExitCaseReport, derived_branch)
        };
        if let Err(err) = auth_res {
            results[index] = Some(fail_item(item.employee_id, &err));
            continue;
        }

        let sole_holder_ops = match preload.own_decisions.get(&item.employee_id) {
            Some(OwnRecord::Refused) => {
                results[index] = Some(fail_item(item.employee_id, &own_record_forbidden()));
                continue;
            }
            Some(OwnRecord::SoleHolderOps) => true,
            _ => false,
        };

        if status == "EXITED" {
            results[index] = Some(err_result(
                item.employee_id,
                "invalid_transition",
                "employee is already EXITED; no exit case can be reported",
            ));
            continue;
        }
        if let Some(hire) = hire
            .as_deref()
            .and_then(|d| parse_yyyy_mm_dd(d.trim()).ok())
            && exit_date_parsed < hire
        {
            results[index] = Some(err_result(
                item.employee_id,
                "effective_date_before_hire",
                format!("effective_exit_date must be on or after the hire date {hire}"),
            ));
            continue;
        }
        if preload.scheduled_terminates.contains(&item.employee_id) {
            results[index] = Some(err_result(
                item.employee_id,
                "invalid_transition",
                "employee already has a scheduled exit; no exit case can be reported",
            ));
            continue;
        }
        if preload.open_cases.contains(&item.employee_id)
            || !seen_employees.insert(item.employee_id)
        {
            results[index] = Some(err_result(
                item.employee_id,
                "exit_case_open",
                "the employee already has an open exit case",
            ));
            continue;
        }
        if let Some(class) = exit_reason
            && let Err(err) = crate::exits::guards::check_exit_guards(
                tx.as_mut(),
                org,
                item.employee_id,
                effective_exit_date,
                class,
                None,
                "report",
                None,
            )
            .await
        {
            results[index] = Some(fail_item(item.employee_id, &err));
            continue;
        }

        admitted.push(AdmittedItem {
            index,
            case_id: Uuid::new_v4(),
            employee_id: item.employee_id,
            branch_id: derived_branch,
            requested_branch_id: item.branch_id,
            absence_alert_id: item.absence_alert_id,
            sole_holder_ops,
        });
    }

    Ok((results, admitted))
}
