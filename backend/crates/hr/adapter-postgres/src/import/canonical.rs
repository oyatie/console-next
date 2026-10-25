//! Canonical import row JSON and the raw-cell text readers.
//! Moved from `app/src/hr.rs` (R2-import).

use console_hr_domain::import::classification::target_header_aliases;
use console_leave_domain::LeaveBalanceAmount;
use serde_json::{Value, json};

use crate::import::parsed::{EmployeeCanonicalFields, ImportRowStatus, ParsedEmployeeImportRow};
use crate::import::types::EmployeeImportColumn;

pub fn import_canonical_row_json(row: &ParsedEmployeeImportRow) -> Value {
    let Some(name) = row.name.as_ref() else {
        return json!({
            "source_filename": &row.source_filename,
            "source_sheet": &row.source_sheet,
            "source_row": row.source_row,
            "source_key": &row.source_key,
            "raw_only_reason": "missing_name"
        });
    };
    json!({
        "company": &row.company,
        "name": name,
        "source_filename": &row.source_filename,
        "source_sheet": &row.source_sheet,
        "source_row": row.source_row,
        "source_key": &row.source_key,
        "source_metadata": &row.source_metadata,
        "canonical": &row.canonical
    })
}

pub fn import_validation_json(row: &ParsedEmployeeImportRow) -> Value {
    match row.row_status {
        ImportRowStatus::Candidate => json!({ "status": "ok", "errors": [], "warnings": [] }),
        ImportRowStatus::Preserved => json!({
            "status": "preserved",
            "errors": [],
            "warnings": ["missing_name_preserved_raw_only"]
        }),
        ImportRowStatus::Error => json!({
            "status": "error",
            "errors": ["invalid_employee_import_row"],
            "warnings": []
        }),
    }
}

pub fn canonical_employee_fields_for_import(
    raw_row: &Value,
    columns: &[EmployeeImportColumn],
) -> EmployeeCanonicalFields {
    let exit_date = raw_text_for_import_target(raw_row, columns, "exit_date");
    EmployeeCanonicalFields {
        place_targets_split: true,
        company_brn: raw_text_for_import_target(raw_row, columns, "company_brn"),
        employee_number: raw_text_for_import_target(raw_row, columns, "employee_number"),
        org_unit: raw_text_for_import_target(raw_row, columns, "org_unit"),
        job: raw_text_for_import_target(raw_row, columns, "job"),
        position: raw_text_for_import_target(raw_row, columns, "position"),
        workplace: raw_text_for_import_target(raw_row, columns, "workplace"),
        worksite_name: raw_text_for_import_target(raw_row, columns, "worksite_name"),
        worksite_address: raw_text_for_import_target(raw_row, columns, "worksite_address"),
        hire_date: raw_text_for_import_target(raw_row, columns, "hire_date"),
        exit_date: exit_date.clone(),
        birth_date: raw_text_for_import_target(raw_row, columns, "birth_date"),
        employment_type: raw_text_for_import_target(raw_row, columns, "employment_type"),
        employment_status: if exit_date.is_some() {
            "EXITED"
        } else {
            "ACTIVE"
        }
        .to_owned(),
        leave_accrued: raw_decimal_text_for_import_target(raw_row, columns, "leave_accrued"),
        leave_used: raw_decimal_text_for_import_target(raw_row, columns, "leave_used"),
        leave_remaining: raw_decimal_text_for_import_target(raw_row, columns, "leave_remaining"),
        ..EmployeeCanonicalFields::default()
    }
}

pub fn raw_decimal_text_for_import_target(
    raw_row: &Value,
    columns: &[EmployeeImportColumn],
    target: &str,
) -> Option<String> {
    let raw = raw_text_for_import_target(raw_row, columns, target)?;
    normalized_decimal_text(&raw)
}

pub fn normalized_decimal_text(raw: &str) -> Option<String> {
    let cleaned = raw.replace(',', "");
    LeaveBalanceAmount::parse_decimal(cleaned.trim())
        .ok()
        .map(LeaveBalanceAmount::canonical_decimal)
}

pub fn raw_text_for_import_target(
    raw_row: &Value,
    columns: &[EmployeeImportColumn],
    target: &str,
) -> Option<String> {
    let object = raw_row.as_object()?;
    columns
        .iter()
        .filter(|column| column.target.as_deref() == Some(target))
        .find_map(|column| {
            let value = object.get(&column.normalized_header)?;
            json_value_text(value)
        })
        .or_else(|| {
            let aliases: Vec<_> = target_header_aliases(target)
                .iter()
                .copied()
                .filter(|alias| !columns.iter().any(|c| c.normalized_header == *alias))
                .collect();
            raw_text(raw_row, &aliases)
        })
}

pub fn raw_text(raw_row: &Value, headers: &[&str]) -> Option<String> {
    let object = raw_row.as_object()?;
    headers.iter().find_map(|header| {
        let value = object.get(*header)?;
        json_value_text(value)
    })
}

pub fn json_value_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(value) => value.trim().to_owned(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null | Value::Array(_) | Value::Object(_) => String::new(),
    };
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod place_compat {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn only_old_staged_runs_decode_worksite_as_workplace() {
        let legacy: EmployeeCanonicalFields =
            serde_json::from_value(json!({"worksite_name":"본사"})).unwrap();
        assert_eq!(legacy.workplace_text().map(String::as_str), Some("본사"));
        let fresh = EmployeeCanonicalFields {
            place_targets_split: true,
            ..legacy
        };
        assert_eq!(fresh.workplace_text(), None);
        let distinct = EmployeeCanonicalFields {
            workplace: Some("판교".into()),
            ..fresh
        };
        assert_eq!(distinct.workplace_text().map(String::as_str), Some("판교"));
    }
}
