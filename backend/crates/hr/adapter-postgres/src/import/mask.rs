//! The import mapping profile and the masked preview values.
//! Moved from `app/src/hr.rs` (R2-import).

use console_hr_domain::import::fields::EMPLOYEE_IMPORT_FIELD_DEFINITIONS;
use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::directory::read_export::neutralize_spreadsheet_formula;
use crate::import::header::MAX_IMPORT_HEADER_SCAN_ROWS;
use crate::import::types::EmployeeImportColumn;

pub fn employee_import_mapping_profile(columns: &[EmployeeImportColumn]) -> Value {
    let target_allowlist = EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .map(|field| field.target)
        .collect::<Vec<_>>();
    let target_catalog = EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .map(|field| {
            json!({
                "target": field.target,
                "aliases": field.aliases,
                "classification": field.classification,
                "required": field.required
            })
        })
        .collect::<Vec<_>>();
    json!({
        "entity_type": "employee_hr",
        "target_allowlist": target_allowlist,
        "target_catalog": target_catalog,
        "columns": columns,
        "policy": {
            "unknown_columns": "retain_raw_only",
            "restricted_columns": "drop_header_only",
            "resident_registration_number_values": "drop_any_column",
            "blank_name_rows": "preserve_raw_only",
            "header_detection": {
                "strategy": "schema_catalog_first_mappable_row",
                "scan_rows": MAX_IMPORT_HEADER_SCAN_ROWS
            },
            "company_resolution": ["placed_workplace_entity", "entity_undecided"],
            "server_side_entity_allowlist": ["employee_hr"]
        }
    })
}

pub fn masked_preview_values(
    raw_row: &Value,
    columns: &[EmployeeImportColumn],
) -> BTreeMap<String, Value> {
    let Some(object) = raw_row.as_object() else {
        return BTreeMap::new();
    };
    columns
        .iter()
        .filter_map(|column| {
            let value = object.get(&column.normalized_header)?;
            let masked = if column.preview_allowed {
                safe_preview_value(value)
            } else if value.is_null() {
                Value::Null
            } else {
                json!("••••")
            };
            Some((column.normalized_header.clone(), masked))
        })
        .collect()
}

pub fn safe_preview_value(value: &Value) -> Value {
    match value {
        Value::String(value) if value.len() > 80 => {
            json!(format!(
                "{}…",
                neutralize_spreadsheet_formula(&value.chars().take(80).collect::<String>())
            ))
        }
        Value::String(value) => json!(neutralize_spreadsheet_formula(value)),
        Value::Number(_) | Value::Bool(_) | Value::Null => value.clone(),
        Value::Array(_) | Value::Object(_) => json!("복합 값"),
    }
}
