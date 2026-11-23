// SPDX-License-Identifier: LicenseRef-Proprietary
//! Validation and in-memory application of inline dry-run cell repairs (`decisions.cells`).

use std::collections::BTreeMap;

use console_hr_domain::import::cells::{DateParseError, parse_import_date_checked};
use console_hr_domain::import::classification::{
    employee_import_field_for_header, is_dropped_employee_import_header,
};
use console_hr_domain::import::detect::known_target;
use console_hr_domain::import::normalize::employee_number;
use console_hr_domain::import::plan_cells_id::FORBIDDEN_CELL_REPAIR_TARGETS;
use console_hr_domain::import::sex::sex_of_text;
use console_hr_domain::profile::identity::parse_id_type_import;
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audit;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Postgres;
use uuid::Uuid;

use crate::authz::authorize_hr_org_wide;
use crate::directory::access_log::import_rows_event;
use crate::import::apply_drive::refuse_while_running;
use crate::import::identities;
use crate::import::store::{import_run_for_update, load_candidate_import_rows};
use crate::import::types::StoredEmployeeImportRow;
use crate::{HrError, HrService};

const DATE_REPAIR_TARGETS: [&str; 7] = [
    "birth_date",
    "hire_date",
    "exit_date",
    "leave_start_date",
    "leave_return_date",
    "contract_end_date",
    "probation_end_date",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCellsRepairRequest {
    pub cells: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportCellsRepairResponse {
    pub run_id: Uuid,
    pub repaired_rows: usize,
    pub cells: BTreeMap<String, BTreeMap<String, String>>,
}

fn unprocessable(code: &'static str, message: String) -> HrError {
    HrError {
        status: http::StatusCode::UNPROCESSABLE_ENTITY,
        code,
        message,
        errors: None,
        refusals: None,
    }
}

/// Validate non-empty date values in `cells` so 2-digit years and invalid calendar dates are
/// rejected at write time with structured codes before dry-run planning.
pub fn validate_cell_date_repairs(
    cells: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), HrError> {
    for (source_key, repairs) in cells {
        for (field, raw) in repairs {
            let trimmed = raw.trim();
            if trimmed.is_empty() || !DATE_REPAIR_TARGETS.contains(&field.as_str()) {
                continue;
            }
            match parse_import_date_checked(trimmed) {
                Ok(_) => {}
                Err(DateParseError::TwoDigitYear) => {
                    return Err(unprocessable(
                        "two_digit_year",
                        format!("two-digit year in {field} for {source_key}; expected YYYY-MM-DD"),
                    ));
                }
                Err(DateParseError::InvalidFormat) => {
                    return Err(unprocessable(
                        "invalid_date",
                        format!("invalid date in {field} for {source_key}; expected YYYY-MM-DD"),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn is_restricted_cell_repair_field(field: &str) -> bool {
    let trimmed = field.trim();
    let lowered = trimmed.to_ascii_lowercase();
    if FORBIDDEN_CELL_REPAIR_TARGETS.contains(&lowered.as_str()) {
        return true;
    }
    if is_dropped_employee_import_header(trimmed) {
        return true;
    }
    employee_import_field_for_header(trimmed)
        .is_some_and(|def| FORBIDDEN_CELL_REPAIR_TARGETS.contains(&def.target))
}

/// Ensure `decisions.cells` only references rows in this run and non-restricted repair targets.
pub fn validate_cell_repairs(
    stored: &[StoredEmployeeImportRow],
    cells: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), HrError> {
    for (key, repairs) in cells {
        if !stored.iter().any(|row| &row.source_key == key) {
            return Err(HrError::validation(format!(
                "decision names a row that is not in this run: {key}"
            )));
        }
        for field in repairs.keys() {
            if is_restricted_cell_repair_field(field) {
                return Err(unprocessable(
                    "mapping_restricted_column",
                    format!("cell repair cannot target restricted or immutable field: {field}"),
                ));
            }
            if known_target(field).is_none() {
                return Err(HrError::validation(format!(
                    "cell repair names unknown target field: {field}"
                )));
            }
        }
    }
    Ok(())
}

/// Apply validated inline repairs in-memory onto stored rows for deterministic planning and batch
/// row emission (without mutating immutable raw staged rows in Postgres).
pub fn apply_cell_repairs_to_stored(
    stored: &mut [StoredEmployeeImportRow],
    cells: &BTreeMap<String, BTreeMap<String, String>>,
) {
    if cells.is_empty() {
        return;
    }
    for row in stored {
        let Some(repairs) = cells.get(&row.source_key) else {
            continue;
        };
        for (field, raw) in repairs {
            let trimmed = raw.trim();
            let opt = (!trimmed.is_empty()).then(|| trimmed.to_owned());
            match field.as_str() {
                "employee_number" => {
                    row.canonical.employee_number = opt.as_deref().and_then(employee_number);
                }
                "hire_date" => row.canonical.hire_date = opt,
                "exit_date" => row.canonical.exit_date = opt,
                "birth_date" => row.canonical.birth_date = opt,
                "org_unit" => row.canonical.org_unit = opt,
                "job" => row.canonical.job = opt,
                "position" => row.canonical.position = opt,
                "workplace" => row.canonical.workplace = opt,
                "worksite_name" => row.canonical.worksite_name = opt,
                "worksite_address" => row.canonical.worksite_address = opt,
                "employment_type" => row.canonical.employment_type = opt,
                "employment_status" => row.canonical.status = opt,
                "leave_start_date" => row.canonical.leave_start_date = opt,
                "leave_type" => row.canonical.leave_type = opt,
                "leave_return_date" => row.canonical.leave_return_date = opt,
                "contract_end_date" => row.canonical.contract_end_date = opt,
                "probation_end_date" => row.canonical.probation_end_date = opt,
                "sex" => {
                    row.canonical.sex = opt
                        .as_deref()
                        .and_then(sex_of_text)
                        .map(str::to_owned)
                        .or(opt);
                }
                "id_type" => {
                    row.canonical.id_type = opt
                        .as_deref()
                        .and_then(parse_id_type_import)
                        .map(|t| t.as_str().to_owned())
                        .or(opt);
                }
                "company" => row.company = opt.unwrap_or_default(),
                "company_brn" => row.canonical.company_brn = opt,
                _ => {}
            }
        }
    }
}

/// Load persisted inline cell repairs (`dry_run_decisions.cells`) for a run.
pub async fn load_stored_cell_repairs(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
) -> Result<BTreeMap<String, BTreeMap<String, String>>, HrError> {
    let stored_cells: Option<Value> = sqlx::query_scalar(
        "SELECT dry_run_decisions->'cells' FROM data_import_runs WHERE org_id = $1 AND id = $2",
    )
    .bind(org_uuid)
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?
    .flatten();
    let Some(cells_val) = stored_cells.filter(|v| !v.is_null()) else {
        return Ok(BTreeMap::new());
    };
    serde_json::from_value(cells_val)
        .map_err(|_| HrError::internal("stored import cell repairs are unreadable"))
}

impl HrService {
    /// Validate and merge inline canonical cell repairs (`dry_run_decisions.cells`) for a staged
    /// employee import run, rejecting restricted PII columns (`rrn`, `phone`, `name`) and 2-digit
    /// years fail-closed.
    pub async fn repair_import_cells(
        &self,
        principal: Principal,
        run_id: Uuid,
        request: ImportCellsRepairRequest,
    ) -> Result<ImportCellsRepairResponse, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let org_uuid = *principal.org_id.as_uuid();
        let after = json!({
            "run_id": run_id,
            "entity_type": "employee_hr",
            "repaired_rows": request.cells.len(),
        });
        let event = import_rows_event(&principal, "data_import.cells_repair", run_id, after)?;
        with_audit::<_, _, HrError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let run = import_run_for_update(tx, org_uuid, run_id).await?;
                if run.entity_type != "employee_hr" {
                    return Err(HrError::validation(
                        "import run entity_type is not employee_hr",
                    ));
                }
                if run.status != "PREVIEWED" && run.status != "DRY_RUN" {
                    return Err(HrError::from_kernel(KernelError::invalid_transition(
                        format!(
                            "cannot repair cells for import run in {} status",
                            run.status
                        ),
                    )));
                }
                identities::require_fresh_run(tx, org_uuid, run_id).await?;
                refuse_while_running(tx, org_uuid, run_id).await?;
                let stored = load_candidate_import_rows(tx, org_uuid, run_id).await?;
                validate_cell_repairs(&stored, &request.cells)?;
                validate_cell_date_repairs(&request.cells)?;

                let existing: Option<Value> = sqlx::query_scalar(
                    "SELECT dry_run_decisions FROM data_import_runs WHERE org_id = $1 AND id = $2",
                )
                .bind(org_uuid)
                .bind(run_id)
                .fetch_optional(tx.as_mut())
                .await?
                .flatten();
                let mut decisions_obj = existing
                    .and_then(|v| v.as_object().cloned())
                    .unwrap_or_default();
                let mut merged_cells: BTreeMap<String, BTreeMap<String, String>> = decisions_obj
                    .get("cells")
                    .cloned()
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();
                for (source_key, fields) in request.cells {
                    let entry = merged_cells.entry(source_key).or_default();
                    for (field, raw) in fields {
                        let trimmed = raw.trim();
                        if trimmed.is_empty() {
                            entry.remove(&field);
                        } else {
                            entry.insert(field, trimmed.to_owned());
                        }
                    }
                }
                merged_cells.retain(|_, v| !v.is_empty());
                decisions_obj.insert("cells".into(), json!(&merged_cells));
                sqlx::query(
                    "UPDATE data_import_runs SET dry_run_decisions = $3, updated_at = now() \
                     WHERE org_id = $1 AND id = $2",
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(Value::Object(decisions_obj))
                .execute(tx.as_mut())
                .await?;
                Ok(ImportCellsRepairResponse {
                    run_id,
                    repaired_rows: merged_cells.len(),
                    cells: merged_cells,
                })
            })
        })
        .await
    }
}
