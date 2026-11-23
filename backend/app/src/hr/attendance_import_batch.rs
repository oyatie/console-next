// SPDX-License-Identifier: LicenseRef-Proprietary
//! Set-based bulk persistence and batch entity lookups for attendance imports.
use std::collections::{BTreeSet, HashMap};

use console_hr_adapter_postgres::HrError;
use sqlx::{Postgres, Row};
use uuid::Uuid;

use super::{
    AttendanceBranchResolution, AttendanceEmployeeResolution, ParsedAttendanceImportRow,
    ResolvedAttendanceImportRow, attendance_canonical_row_json, attendance_validation_json,
};

pub(super) async fn insert_attendance_import_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
    rows: &[ParsedAttendanceImportRow],
    source_sha256: &str,
) -> Result<(), HrError> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut source_sheets = Vec::with_capacity(rows.len());
    let mut source_rows = Vec::with_capacity(rows.len());
    let mut source_keys = Vec::with_capacity(rows.len());
    let mut row_statuses = Vec::with_capacity(rows.len());
    let mut raw_rows = Vec::with_capacity(rows.len());
    let mut canonical_rows = Vec::with_capacity(rows.len());
    let mut validations = Vec::with_capacity(rows.len());

    for row in rows {
        source_sheets.push(row.source_sheet.clone());
        source_rows.push(row.source_row);
        source_keys.push(row.source_key.clone());
        row_statuses.push(row.row_status.as_str().to_owned());
        raw_rows.push(row.raw_row.clone());
        canonical_rows.push(attendance_canonical_row_json(row, source_sha256));
        validations.push(attendance_validation_json(row));
    }

    sqlx::query(
        r#"
        INSERT INTO data_import_rows (
            org_id, run_id, source_sheet, source_row, source_key,
            row_status, raw_row, canonical_row, validation
        )
        SELECT
            $1, $2, t.source_sheet, t.source_row, t.source_key,
            t.row_status, t.raw_row, t.canonical_row, t.validation
        FROM UNNEST(
            $3::text[], $4::int4[], $5::text[],
            $6::text[], $7::jsonb[], $8::jsonb[], $9::jsonb[]
        ) AS t(
            source_sheet, source_row, source_key,
            row_status, raw_row, canonical_row, validation
        )
        "#,
    )
    .bind(org_uuid)
    .bind(run_id)
    .bind(&source_sheets)
    .bind(&source_rows)
    .bind(&source_keys)
    .bind(&row_statuses)
    .bind(&raw_rows)
    .bind(&canonical_rows)
    .bind(&validations)
    .execute(tx.as_mut())
    .await?;

    Ok(())
}

pub(super) async fn insert_attendance_direct_import_events(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
    source_sha256: &str,
    rows: &[ResolvedAttendanceImportRow],
) -> Result<usize, HrError> {
    if rows.is_empty() {
        return Ok(0);
    }
    let mut import_row_ids = Vec::with_capacity(rows.len());
    let mut employee_ids = Vec::with_capacity(rows.len());
    let mut branch_ids = Vec::with_capacity(rows.len());
    let mut source_sheets = Vec::with_capacity(rows.len());
    let mut source_rows = Vec::with_capacity(rows.len());
    let mut source_keys = Vec::with_capacity(rows.len());
    let mut employee_numbers = Vec::with_capacity(rows.len());
    let mut employee_names = Vec::with_capacity(rows.len());
    let mut branch_names = Vec::with_capacity(rows.len());
    let mut work_dates = Vec::with_capacity(rows.len());
    let mut check_in_ats = Vec::with_capacity(rows.len());
    let mut check_out_ats = Vec::with_capacity(rows.len());
    let mut minutes_workeds = Vec::with_capacity(rows.len());
    let mut fact_keys = Vec::with_capacity(rows.len());

    for row in rows {
        import_row_ids.push(row.import_row_id);
        employee_ids.push(row.employee_id);
        branch_ids.push(row.branch_id);
        source_sheets.push(row.source_sheet.clone());
        source_rows.push(row.source_row);
        source_keys.push(row.source_key.clone());
        employee_numbers.push(row.employee_number.clone());
        employee_names.push(row.employee_name.clone());
        branch_names.push(row.branch_name.clone());
        work_dates.push(row.work_date.clone());
        check_in_ats.push(row.check_in_at.clone());
        check_out_ats.push(row.check_out_at.clone());
        minutes_workeds.push(row.minutes_worked);
        fact_keys.push(row.fact_key.clone());
    }

    let result = sqlx::query(
        r#"
        INSERT INTO attendance_direct_import_events (
            org_id, run_id, import_row_id, employee_id, branch_id,
            source_sheet, source_row, source_key, source_sha256,
            employee_number, employee_name, branch_name, work_date,
            check_in_at, check_out_at, minutes_worked, fact_key
        )
        SELECT
            $1, $2, t.import_row_id, t.employee_id, t.branch_id,
            t.source_sheet, t.source_row, t.source_key, $3,
            t.employee_number, t.employee_name, t.branch_name, t.work_date,
            t.check_in_at, t.check_out_at, t.minutes_worked, t.fact_key
        FROM UNNEST(
            $4::uuid[], $5::uuid[], $6::uuid[],
            $7::text[], $8::int4[], $9::text[],
            $10::text[], $11::text[], $12::text[], $13::text[],
            $14::text[], $15::text[], $16::int4[], $17::text[]
        ) AS t(
            import_row_id, employee_id, branch_id,
            source_sheet, source_row, source_key,
            employee_number, employee_name, branch_name, work_date,
            check_in_at, check_out_at, minutes_worked, fact_key
        )
        ON CONFLICT (org_id, fact_key) DO NOTHING
        "#,
    )
    .bind(org_uuid)
    .bind(run_id)
    .bind(source_sha256)
    .bind(&import_row_ids)
    .bind(&employee_ids)
    .bind(&branch_ids)
    .bind(&source_sheets)
    .bind(&source_rows)
    .bind(&source_keys)
    .bind(&employee_numbers)
    .bind(&employee_names)
    .bind(&branch_names)
    .bind(&work_dates)
    .bind(&check_in_ats)
    .bind(&check_out_ats)
    .bind(&minutes_workeds)
    .bind(&fact_keys)
    .execute(tx.as_mut())
    .await?;

    Ok(usize::try_from(result.rows_affected()).unwrap_or_default())
}

pub(super) async fn load_employees_by_number(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    numbers: BTreeSet<String>,
) -> Result<HashMap<String, Vec<AttendanceEmployeeResolution>>, HrError> {
    if numbers.is_empty() {
        return Ok(HashMap::new());
    }
    let keys: Vec<String> = numbers.into_iter().collect();
    let rows = sqlx::query(
        r#"
        SELECT id, name, employee_number
        FROM person_employees_current
        WHERE org_id = $1 AND employee_number = ANY($2)
        ORDER BY id
        "#,
    )
    .bind(org_uuid)
    .bind(&keys)
    .fetch_all(tx.as_mut())
    .await?;
    let mut map: HashMap<String, Vec<AttendanceEmployeeResolution>> = HashMap::new();
    for row in rows {
        let employee_number: Option<String> = row.try_get("employee_number")?;
        if let Some(num) = employee_number.clone() {
            map.entry(num)
                .or_default()
                .push(AttendanceEmployeeResolution {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    employee_number,
                });
        }
    }
    Ok(map)
}

pub(super) async fn load_employees_by_name(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    names: BTreeSet<String>,
) -> Result<HashMap<String, Vec<AttendanceEmployeeResolution>>, HrError> {
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let keys: Vec<String> = names.into_iter().collect();
    let rows = sqlx::query(
        r#"
        SELECT id, name, employee_number
        FROM person_employees_current
        WHERE org_id = $1 AND name = ANY($2)
        ORDER BY id
        "#,
    )
    .bind(org_uuid)
    .bind(&keys)
    .fetch_all(tx.as_mut())
    .await?;
    let mut map: HashMap<String, Vec<AttendanceEmployeeResolution>> = HashMap::new();
    for row in rows {
        let name: String = row.try_get("name")?;
        map.entry(name.clone())
            .or_default()
            .push(AttendanceEmployeeResolution {
                id: row.try_get("id")?,
                name,
                employee_number: row.try_get("employee_number")?,
            });
    }
    Ok(map)
}

pub(super) async fn load_branches_by_name(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    names: BTreeSet<String>,
) -> Result<HashMap<String, Vec<AttendanceBranchResolution>>, HrError> {
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let keys: Vec<String> = names.into_iter().collect();
    let rows = sqlx::query(
        r#"
        SELECT id, name
        FROM branches
        WHERE org_id = $1 AND name = ANY($2)
        ORDER BY id
        "#,
    )
    .bind(org_uuid)
    .bind(&keys)
    .fetch_all(tx.as_mut())
    .await?;
    let mut map: HashMap<String, Vec<AttendanceBranchResolution>> = HashMap::new();
    for row in rows {
        let name: String = row.try_get("name")?;
        map.entry(name.clone())
            .or_default()
            .push(AttendanceBranchResolution {
                id: row.try_get("id")?,
                name,
            });
    }
    Ok(map)
}
