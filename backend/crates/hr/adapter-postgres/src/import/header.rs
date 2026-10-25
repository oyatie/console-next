//! The detected employee import header, its columns and the RRN label refusal.
//! Moved from `app/src/hr.rs` (R2-import).

use console_hr_domain::import::classification::{
    employee_import_column_classification, employee_import_target_for_header,
};
use console_hr_domain::import::rrn::is_rrn_value;

use crate::HrError;
use crate::import::types::EmployeeImportColumn;

pub const MAX_IMPORT_HEADER_SCAN_ROWS: usize = 25;

#[derive(Debug)]
pub struct EmployeeImportHeader {
    pub zero_based_row: usize,
    pub normalized_headers: Vec<String>,
    pub columns: Vec<EmployeeImportColumn>,
    pub name_index: usize,
}

pub fn employee_import_column(
    source_header: &str,
    normalized_header: &str,
) -> EmployeeImportColumn {
    let target = employee_import_target_for_header(normalized_header).map(ToOwned::to_owned);
    let classification =
        employee_import_column_classification(normalized_header, target.as_deref());
    EmployeeImportColumn {
        source_header: source_header.trim().to_owned(),
        normalized_header: normalized_header.to_owned(),
        target,
        preview_allowed: classification == "canonical" || classification == "retained",
        classification: classification.to_owned(),
        notice: None,
        place_reading_required: None,
    }
}

/// G9: refuses an upload that is not an `.xlsx` (ZIP) before the parser sees
/// it — 422 `workbook_protected` for a password/DRM container, 422
/// `workbook_not_xlsx` otherwise.
pub fn check_employee_workbook(bytes: &[u8]) -> Result<(), HrError> {
    console_hr_domain::import::workbook::check_workbook_signature(bytes).map_err(|code| HrError {
        errors: None,
        status: http::StatusCode::UNPROCESSABLE_ENTITY,
        code,
        message: match code {
            "workbook_protected" => "the workbook is password- or DRM-protected; remove the protection and upload it again",
            _ => "the file is not an .xlsx workbook",
        }
        .to_owned(),
        refusals: None,
    })
}

/// Refuses an upload whose file or sheet name carries an RRN: those names are
/// stored verbatim as run, row and employee lineage, so they cannot be dropped
/// like a cell.
pub fn reject_rrn_label(label: &str, message: &'static str) -> Result<(), HrError> {
    if is_rrn_value(label) {
        return Err(HrError::validation(message));
    }
    Ok(())
}
