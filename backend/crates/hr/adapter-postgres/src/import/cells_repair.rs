// SPDX-License-Identifier: LicenseRef-Proprietary
//! Validation and in-memory application of inline dry-run cell repairs (`decisions.cells`).

use std::collections::BTreeMap;

use console_hr_domain::import::detect::known_target;
use console_hr_domain::import::normalize::employee_number;
use console_hr_domain::import::plan_cells_id::FORBIDDEN_CELL_REPAIR_TARGETS;
use console_hr_domain::import::sex::sex_of_text;
use console_hr_domain::profile::identity::parse_id_type_import;
use console_kernel_core::KernelError;

use crate::HrError;
use crate::import::types::StoredEmployeeImportRow;

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
            if FORBIDDEN_CELL_REPAIR_TARGETS.contains(&field.as_str()) {
                return Err(HrError::from_kernel(
                    KernelError::validation(format!(
                        "cell repair cannot target restricted or immutable field: {field}"
                    ))
                    .with_code("mapping_restricted_column"),
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
