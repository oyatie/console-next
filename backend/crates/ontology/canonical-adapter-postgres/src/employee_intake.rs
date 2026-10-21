//! IMPORT lane (BW-19, BW-10) writes on the legacy `employees` head.
//! `employees` belongs to `ObjectKey::Employment`, so the DML lives here; the
//! HR adapter validates and authorizes, then calls these inside its own
//! transaction.

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// BW-19 4: a registration dated after today is 입사 예정. Called right after
/// [`crate::employment::insert_employee_record`] in the same transaction, so
/// the row is never seen ACTIVE; the scheduled ONBOARD makes it ACTIVE on the
/// hire date.
///
/// # Errors
/// The driver error verbatim.
pub async fn mark_pre_hire(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE employees SET employment_status = 'PRE_HIRE' \
         WHERE org_id = $1 AND id = $2 AND employment_status = 'ACTIVE'",
    )
    .bind(org_id)
    .bind(employee_id)
    .execute(tx.as_mut())
    .await
    .map(|_| ())
}

/// The head of a REHIRE: the new employment period's start and placement.
pub struct RehirePeriod<'a> {
    /// `ACTIVE`, or `PRE_HIRE` when `hire_date` is after today.
    pub employment_status: &'a str,
    /// `YYYY-MM-DD`: the new period's first day.
    pub hire_date: &'a str,
    pub company: &'a str,
    pub org_unit: &'a str,
    pub org_unit_id: Uuid,
    pub position: &'a str,
}

/// BW-19 2: starts a new employment period on an EXITED head (the same
/// person, the same 사번): status, hire date and placement; `exit_date`
/// clears. Returns false when the head is no longer EXITED (nothing written).
///
/// # Errors
/// The driver error verbatim.
pub async fn start_rehire_period(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    period: &RehirePeriod<'_>,
) -> Result<bool, sqlx::Error> {
    sqlx::query(
        "UPDATE employees SET employment_status = $3, hire_date = $4, exit_date = NULL, \
                company = $5, org_unit = $6, org_unit_id = $7, position = $8, updated_at = now() \
         WHERE org_id = $1 AND id = $2 AND employment_status = 'EXITED'",
    )
    .bind(org_id)
    .bind(employee_id)
    .bind(period.employment_status)
    .bind(period.hire_date)
    .bind(period.company)
    .bind(period.org_unit)
    .bind(period.org_unit_id)
    .bind(period.position)
    .execute(tx.as_mut())
    .await
    .map(|done| done.rows_affected() == 1)
}
