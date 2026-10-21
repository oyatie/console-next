//! BW-18 legacy-head corrections (정정): the `employees` writes a master-data
//! correction and an identity resolution need. This crate is the contract's
//! `ObjectKey::Employment` owner, the one crate permitted to hold DML against
//! `employees` (writer-ownership gate); the HR adapter calls these inside its
//! decision transaction, which already locked the row and checked its version.

use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// The `employees` columns a 정정 may write, in the order of the statement's
/// parameters. `name`, `hire_date`, `exit_date` and `employee_number` are
/// never cleared (the HR adapter refuses a null for them before calling here).
pub const CORRECTABLE_HEAD_COLUMNS: [&str; 13] = [
    "name",
    "hire_date",
    "exit_date",
    "employee_number",
    "job",
    "birth_date",
    "work_email",
    "id_type",
    "grade_id",
    "job_title_id",
    "position_kind_id",
    "job_id",
    "job_family_id",
];

/// Writes the corrected legacy-head values (`None` clears the column; a
/// column not named keeps its value) and bumps `updated_at`, the version the
/// next optimistic write compares against. A written 사번 also clears the
/// MR-28 legacy-duplicate flag, so the record joins the unique index (a
/// still-shared 사번 then fails with 23505 on
/// `employees_org_employee_number_key`). The TEXT `hire_date` / `exit_date`
/// keep their DATE twins in step through the PA-DATE trigger. A `job` text
/// correction unbinds the 직무 catalog id (MR-25 `job_id`): the corrected text
/// is no longer that entry's label; APPOINT re-binds one. Returns the new
/// `updated_at`.
///
/// # Errors
/// `ColumnNotFound` for a column outside [`CORRECTABLE_HEAD_COLUMNS`]; the
/// driver error verbatim otherwise (`RowNotFound` when the row is gone).
pub async fn correct_employee_head_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    values: &[(&str, Option<&str>)],
) -> Result<OffsetDateTime, sqlx::Error> {
    if let Some((column, _)) = values
        .iter()
        .find(|(column, _)| !CORRECTABLE_HEAD_COLUMNS.contains(column))
    {
        return Err(sqlx::Error::ColumnNotFound((*column).to_owned()));
    }
    let mut query = sqlx::query_scalar(
        "UPDATE employees SET \
         name = CASE WHEN $3 THEN $4 ELSE name END, \
         hire_date = CASE WHEN $5 THEN $6 ELSE hire_date END, \
         exit_date = CASE WHEN $7 THEN $8 ELSE exit_date END, \
         employee_number = CASE WHEN $9 THEN $10 ELSE employee_number END, \
         employee_number_legacy_duplicate = CASE WHEN $9 THEN false \
                                            ELSE employee_number_legacy_duplicate END, \
         job = CASE WHEN $25 THEN (SELECT label FROM job_titles WHERE org_id = $1 AND id = $26::uuid) \
                    WHEN $11 THEN $12 ELSE job END, \
         job_id = CASE WHEN $25 THEN $26::uuid WHEN $11 THEN NULL ELSE job_id END, \
         birth_date = CASE WHEN $13 THEN $14::date ELSE birth_date END, \
         work_email = CASE WHEN $15 THEN $16 ELSE work_email END, \
         id_type = CASE WHEN $17 THEN $18 ELSE id_type END, \
         grade_id = CASE WHEN $19 THEN $20::uuid ELSE grade_id END, \
         job_title_id = CASE WHEN $21 THEN $22::uuid ELSE job_title_id END, \
         position = CASE WHEN $21 THEN (SELECT label FROM job_titles WHERE org_id = $1 AND id = $22::uuid) ELSE position END, \
         position_kind_id = CASE WHEN $23 THEN $24::uuid ELSE position_kind_id END, \
         job_family_id = CASE WHEN $27 THEN $28::uuid ELSE job_family_id END, \
         head_version = head_version + CASE WHEN $19 OR $21 OR $23 OR $25 OR $27 THEN 1 ELSE 0 END, \
         updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING updated_at",
    )
    .bind(org_id)
    .bind(employee_id);
    for column in CORRECTABLE_HEAD_COLUMNS {
        let value = values.iter().find(|(name, _)| *name == column);
        query = query
            .bind(value.is_some())
            .bind(value.and_then(|(_, value)| *value));
    }
    query.fetch_one(tx.as_mut()).await
}

/// Clears `identity_review_required` once a person resolved the record
/// (BW-18 identity resolution) and bumps `updated_at`.
///
/// # Errors
/// The driver error verbatim; `RowNotFound` when the row is gone.
pub async fn clear_identity_review_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
) -> Result<OffsetDateTime, sqlx::Error> {
    sqlx::query_scalar(
        "UPDATE employees SET identity_review_required = FALSE, updated_at = now() \
         WHERE org_id = $1 AND id = $2 RETURNING updated_at",
    )
    .bind(org_id)
    .bind(employee_id)
    .fetch_one(tx.as_mut())
    .await
}
