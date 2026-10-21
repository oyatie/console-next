//! `data_import_runs` / `data_import_rows` reads for dry-run and apply.
//! Moved from `app/src/hr.rs` (R2-import).

use console_kernel_core::KernelError;
use serde_json::{Value, json};
use sqlx::{Postgres, Row};
use uuid::Uuid;

use crate::HrError;
use crate::import::parsed::EmployeeCanonicalFields;
use crate::import::types::{DataImportRunRecord, StoredEmployeeImportRow};

pub async fn import_run_for_update(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
) -> Result<DataImportRunRecord, HrError> {
    let row = sqlx::query(
        r#"
        SELECT entity_type, status, source_sha256, input_rows, candidate_rows, preserved_rows
        FROM data_import_runs
        WHERE org_id = $1 AND id = $2
        FOR UPDATE
        "#,
    )
    .bind(org_uuid)
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| HrError::from_kernel(KernelError::not_found("import run not found")))?;

    Ok(DataImportRunRecord {
        entity_type: row.try_get("entity_type")?,
        status: row.try_get("status")?,
        source_sha256: row.try_get("source_sha256")?,
        input_rows: row.try_get("input_rows")?,
        candidate_rows: row.try_get("candidate_rows")?,
        preserved_rows: row.try_get("preserved_rows")?,
    })
}

pub async fn load_candidate_import_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
) -> Result<Vec<StoredEmployeeImportRow>, HrError> {
    sqlx::query(
        r#"
        SELECT raw_row, canonical_row
        FROM data_import_rows
        WHERE org_id = $1 AND run_id = $2 AND row_status = 'CANDIDATE'
        ORDER BY source_sheet ASC, source_row ASC
        "#,
    )
    .bind(org_uuid)
    .bind(run_id)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .map(|row| stored_employee_import_row(row.try_get("raw_row")?, row.try_get("canonical_row")?))
    .collect()
}

pub fn stored_employee_import_row(
    raw_row: Value,
    canonical_row: Value,
) -> Result<StoredEmployeeImportRow, HrError> {
    let source_metadata = canonical_row
        .get("source_metadata")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let canonical = serde_json::from_value::<EmployeeCanonicalFields>(
        canonical_row
            .get("canonical")
            .cloned()
            .unwrap_or_else(|| json!({ "employment_status": "ACTIVE" })),
    )
    .map_err(|err| HrError::validation(format!("stored import canonical row is invalid: {err}")))?;
    Ok(StoredEmployeeImportRow {
        // r3:hire-01: empty when the file has no 법인 column.
        company: canonical_row
            .get("company")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        name: required_json_string(&canonical_row, "name")?,
        source_filename: required_json_string(&canonical_row, "source_filename")?,
        source_sheet: required_json_string(&canonical_row, "source_sheet")?,
        source_row: required_json_i32(&canonical_row, "source_row")?,
        source_key: required_json_string(&canonical_row, "source_key")?,
        raw_row,
        source_metadata,
        canonical,
    })
}

pub fn required_json_string(value: &Value, key: &'static str) -> Result<String, HrError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| HrError::validation(format!("stored import row is missing {key}")))
}

pub fn required_json_i32(value: &Value, key: &'static str) -> Result<i32, HrError> {
    let number = value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| HrError::validation(format!("stored import row is missing {key}")))?;
    i32::try_from(number)
        .map_err(|_| HrError::validation(format!("stored import row {key} does not fit i32")))
}
