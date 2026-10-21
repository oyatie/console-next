//! EMP-MODEL person facts on the legacy `employees` head (parity E3, E4):
//! 생년월일, 업무용 이메일 and 신분증명 종류. `employees` belongs to
//! `ObjectKey::Employment`, so its DML lives in this crate; the HR adapter
//! validates and authorizes, then calls this inside its own transaction.

use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

/// The three person facts as they will be stored (already validated).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmployeePersonFacts<'a> {
    pub birth_date: Option<Date>,
    pub work_email: Option<&'a str>,
    pub id_type: Option<&'a str>,
}

/// Writes the person facts and bumps `updated_at`, in the caller's
/// transaction (which holds the row lock).
///
/// # Errors
/// The driver error verbatim (a CHECK refusal surfaces as 23514).
pub async fn set_employee_person_facts(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    facts: EmployeePersonFacts<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE employees SET birth_date = $3, work_email = $4, id_type = $5, updated_at = now() \
         WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(employee_id)
    .bind(facts.birth_date)
    .bind(facts.work_email)
    .bind(facts.id_type)
    .execute(tx.as_mut())
    .await
    .map(|_| ())
}

/// Bumps `updated_at` for an edit that changed only the employment profile,
/// so the facts record's provenance timestamp moves with it (ME-8).
///
/// # Errors
/// The driver error verbatim.
pub async fn touch_employee(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE employees SET updated_at = now() WHERE org_id = $1 AND id = $2")
        .bind(org_id)
        .bind(employee_id)
        .execute(tx.as_mut())
        .await
        .map(|_| ())
}
