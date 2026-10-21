//! BW-13: the employee's catalog title (`employees.job_title_id`), MR-25: the
//! other four catalog ids and the 종사 업무 text; BW-11: its
//! lifecycle version pin (`employees.head_version`). `employees`
//! belongs to `ObjectKey::Employment`, so its DML lives in this crate; the HR
//! lifecycle validates the PROMOTE (active title, 강등 reason) and calls this
//! inside its own transaction, after `employment::apply_employment_change`
//! has written the display text (`position`).

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Sets (or, for a PROMOTE by free text, clears) the employee's catalog title.
///
/// # Errors
/// The driver error verbatim (an unknown id surfaces as the 23503 FK refusal).
pub async fn set_employee_job_title(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    job_title_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE employees SET job_title_id = $3 WHERE org_id = $1 AND id = $2")
        .bind(org_id)
        .bind(employee_id)
        .bind(job_title_id)
        .execute(tx.as_mut())
        .await
        .map(|_| ())
}

/// BW-11: moves the lifecycle version pin (`employees.head_version`, 0256).
///
/// only lifecycle writes bump it (record, scheduled apply, exit
/// confirm); import, create and EXIT_REVERSAL do not. Move the bump into
/// `apply_employment_change` when R9 opens that file.
///
/// # Errors
/// The driver error verbatim.
pub async fn bump_head_version(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE employees SET head_version = head_version + 1 WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(employee_id)
    .execute(tx.as_mut())
    .await
    .map(|_| ())
}

/// MR-25: the employee's 직급, 직책, 직무 and 직군 catalog ids (in that order)
/// and the 종사 업무 text, as a PROMOTE or APPOINT leaves them (or a
/// rescission restores them). The 0266 trigger refuses an id of another kind.
///
/// # Errors
/// The driver error verbatim (23503 for an unknown id, 23514 for a wrong kind).
pub async fn set_employee_classification(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    ids: [Option<Uuid>; 4],
    job: Option<&str>,
) -> Result<(), sqlx::Error> {
    let [grade, position_kind, job_id, job_family] = ids;
    sqlx::query(
        "UPDATE employees SET grade_id = $3, position_kind_id = $4, job_id = $5, \
         job_family_id = $6, job = $7 WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(employee_id)
    .bind(grade)
    .bind(position_kind)
    .bind(job_id)
    .bind(job_family)
    .bind(job)
    .execute(tx.as_mut())
    .await
    .map(|_| ())
}
