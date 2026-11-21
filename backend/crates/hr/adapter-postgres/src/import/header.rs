//! The detected employee import header, its columns and the RRN label refusal.
//! Moved from `app/src/hr.rs` (R2-import).

use console_hr_domain::import::classification::{
    allowed_restricted_target, employee_import_column_classification,
    employee_import_target_for_header, is_dropped_employee_import_header, normalize_header_label,
};
use console_hr_domain::import::rrn::is_rrn_value;
use sqlx::Postgres;
use uuid::Uuid;

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

/// Whether `header` is permitted to map to `target` (non-restricted headers
/// may map to any catalog target; restricted headers may map only to their
/// own governed target, `rrn` or `phone`).
#[must_use]
pub fn allowed_column_target(header: &str, target: &str) -> bool {
    let normalized = normalize_header_label(header);
    !is_dropped_employee_import_header(&normalized)
        || Some(target) == allowed_restricted_target(&normalized)
}

/// Refuses a stored `mapping_profile` whose `columns` bind a restricted
/// header to a non-governed target (`422 mapping_restricted_column`).
pub fn validate_mapping_profile_columns(profile: &serde_json::Value) -> Result<(), HrError> {
    for col in profile["columns"].as_array().into_iter().flatten() {
        let header = col["source_header"]
            .as_str()
            .or_else(|| col["normalized_header"].as_str())
            .unwrap_or_default();
        if let Some(target) = col["target"].as_str()
            && !allowed_column_target(header, target)
        {
            return Err(HrError {
                errors: None,
                status: http::StatusCode::UNPROCESSABLE_ENTITY,
                code: "mapping_restricted_column",
                message: format!("restricted import column cannot be mapped to {target}"),
                refusals: None,
            });
        }
    }
    Ok(())
}

pub(crate) async fn validate_run_mapping_profile(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
) -> Result<(), HrError> {
    let profile: serde_json::Value = sqlx::query_scalar(
        "SELECT mapping_profile FROM data_import_runs WHERE org_id = $1 AND id = $2",
    )
    .bind(org_uuid)
    .bind(run_id)
    .fetch_one(tx.as_mut())
    .await?;
    validate_mapping_profile_columns(&profile)
}
