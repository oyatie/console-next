//! MR-26 등록 취소: the `employees` writes of a void (this crate is the
//! `ObjectKey::Employment` owner, the one crate with DML on `employees`).
//! The HR adapter calls these inside its decision transaction, after it
//! locked the row and decided the void is allowed.
//!
//! A voided row is hidden from the runtime role by the 0277 `hide_voided`
//! policy; [`include_voided`] opens it for one statement and closes it again.

use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// Shows (`true`) or hides voided records for the rest of the transaction,
/// until the next call. Callers close it again after their statement.
///
/// # Errors
/// The driver error verbatim.
pub async fn include_voided(
    tx: &mut Transaction<'_, Postgres>,
    on: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('app.include_voided', $1, true)")
        .bind(if on { "on" } else { "off" })
        .execute(tx.as_mut())
        .await
        .map(drop)
}

/// The void facts written on the record.
pub struct VoidMark<'a> {
    pub voided_by: Uuid,
    pub reason_code: &'a str,
    /// SETUP, GOVERNED or SOLE_HOLDER (0277 CHECK).
    pub mode: &'a str,
}

/// Marks the record VOIDED and bumps `updated_at`. Returns the new
/// `updated_at`.
///
/// # Errors
/// The driver error verbatim (`RowNotFound` when the row is gone).
pub async fn void_employee_head_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    mark: &VoidMark<'_>,
) -> Result<OffsetDateTime, sqlx::Error> {
    // The new row must pass hide_voided's check, so it is visible for this
    // statement only.
    include_voided(tx, true).await?;
    let updated_at = sqlx::query_scalar(
        "UPDATE employees SET employment_status = 'VOIDED', voided_at = now(), voided_by = $3, \
         void_reason_code = $4, void_mode = $5, updated_at = now() \
         WHERE org_id = $1 AND id = $2 RETURNING updated_at",
    )
    .bind(org_id)
    .bind(employee_id)
    .bind(mark.voided_by)
    .bind(mark.reason_code)
    .bind(mark.mode)
    .fetch_one(tx.as_mut())
    .await;
    include_voided(tx, false).await?;
    updated_at
}

/// Destroys a voided record's personal data (0277 `employee_void_destroy_pii`:
/// the head, the profile, the correction ledger's values and the person's
/// unshared name history). `release_number` frees the 사번 too: only a SETUP
/// delete, which nothing can have referenced, passes `true`.
///
/// # Errors
/// The driver error verbatim; the function refuses anything but a VOIDED
/// record that still holds personal data.
pub async fn destroy_voided_pii_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    employee_id: Uuid,
    release_number: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT employee_void_destroy_pii($1, $2)")
        .bind(employee_id)
        .bind(release_number)
        .execute(tx.as_mut())
        .await
        .map(drop)
}
