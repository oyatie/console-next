//! The legacy compatibility head: the `employees` statements the REST handlers
//! and the port share, each run inside the caller's transaction.

use super::change_window::assert_employment_change_window_open;
use super::error::EmploymentError;
use console_kernel_core::KernelError;
use sqlx::{Postgres, Row, Transaction};
use std::collections::HashMap;
use time::Date;
use uuid::Uuid;

/// The `employees` row an appointment creates.
///
/// `home_branch_id` is deliberately absent: since 0166 the branch routing
/// authority is command-only and the `console_rt` guard rejects it here, so the
/// caller establishes it post-commit.
#[derive(Debug, Clone, Copy)]
pub struct NewEmployeeRecord<'a> {
    pub employee_id: Uuid,
    pub company: &'a str,
    pub name: &'a str,
    pub employee_number: &'a str,
    pub org_unit: &'a str,
    pub position: &'a str,
    pub worksite_name: &'a str,
    /// `YYYY-MM-DD`; `None` leaves the hire date null (recruiting hire).
    /// Written to the DATE column `hire_on` (PA-DATE); the expand migration's
    /// trigger mirrors it into the legacy `hire_date` text.
    pub hire_date: Option<&'a str>,
}

/// One employment change applied to the legacy head: the company/org-unit/
/// position triple plus the status. `effective_date` becomes `exit_date` when
/// the status is `EXITED`; any other admitted status clears `exit_date` so a
/// reactivation cannot leave status and exit date disagreeing. `position: None`
/// keeps the current text: a canonical revision with no JobPosition (an HR
/// free-text title such as "Staff") must not erase the title the person holds.
#[derive(Debug, Clone, Copy)]
pub struct EmploymentChange<'a> {
    pub company: &'a str,
    pub org_unit: Option<&'a str>,
    pub position: Option<&'a str>,
    pub employment_status: &'a str,
    pub effective_date: &'a str,
}

/// Creates the legacy `employees` row for a new appointment, inside the
/// caller's transaction.
///
/// # Errors
/// Returns the driver error verbatim so the caller can map `23505` (employee
/// number already in use) to its own conflict.
pub async fn insert_employee_record(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    record: NewEmployeeRecord<'_>,
) -> Result<(), sqlx::Error> {
    insert_employee_records(tx, org_id, &[record]).await
}

/// Inserts registration heads in one statement; callers own authorization and rollback.
/// Home-branch authority remains with the post-commit routing command.
/// Number order keeps the uniqueness trigger's locks consistent across overlapping batches.
pub async fn insert_employee_records(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    records: &[NewEmployeeRecord<'_>],
) -> Result<(), sqlx::Error> {
    if records.is_empty() {
        return Ok(());
    }
    sqlx::query(
        r#"INSERT INTO employees (
            id, org_id, company, name, employee_number, org_unit, position,
            worksite_name, source_filename, source_sheet,
            source_row, source_key, raw_row, source_metadata,
            identity_resolution_strategy, identity_resolution_confidence,
            identity_review_required, identity_name_only_merge, hire_on
        ) SELECT id, $1, company, name, employee_number, org_unit, position,
            site, 'console', 'people', 1, 'console:' || employee_number,
            '{}'::jsonb, '{}'::jsonb, 'employee_number', 'high', FALSE, FALSE, hire_date::DATE
          FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[],
                      $7::text[], $8::text[], $9::text[])
          AS input(id,company,name,employee_number,org_unit,position,site,hire_date)
          ORDER BY employee_number,id"#,
    )
    .bind(org_id)
    .bind(records.iter().map(|r| r.employee_id).collect::<Vec<_>>())
    .bind(records.iter().map(|r| r.company).collect::<Vec<_>>())
    .bind(records.iter().map(|r| r.name).collect::<Vec<_>>())
    .bind(
        records
            .iter()
            .map(|r| r.employee_number)
            .collect::<Vec<_>>(),
    )
    .bind(records.iter().map(|r| r.org_unit).collect::<Vec<_>>())
    .bind(records.iter().map(|r| r.position).collect::<Vec<_>>())
    .bind(records.iter().map(|r| r.worksite_name).collect::<Vec<_>>())
    .bind(records.iter().map(|r| r.hire_date).collect::<Vec<_>>())
    .execute(tx.as_mut())
    .await
    .map(|_| ())
}

/// Applies one employment change to the legacy `employees` head, inside the
/// caller's transaction.
///
/// §3.9.1 change-freeze window: before the UPDATE, the effective date is checked against
/// the platform period locks (Payroll + Accounting). A change whose effective
/// date falls inside a closed period is refused and the caller's transaction
/// rolls back whole. This statement is the LIVE-head rewrite, so the port calls
/// it only for non-backdated Promote/Transfer; the REST lifecycle handlers call
/// it directly, which is why the gate lives here rather than only in the port.
///
/// # Errors
/// `Frozen` when a period lock closes the effective date (or the effective date
/// is not an ISO date, mapped to a validation refusal); `Database` verbatim
/// from the driver.
pub async fn apply_employment_change(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    change: EmploymentChange<'_>,
) -> Result<(), EmploymentError> {
    let effective_date = Date::parse(
        change.effective_date,
        &time::format_description::well_known::Iso8601::DATE,
    )
    .map_err(|error| {
        EmploymentError::Frozen(KernelError::validation(format!(
            "employment change effective_date {:?} is not an ISO date: {error}",
            change.effective_date
        )))
    })?;
    assert_employment_change_window_open(tx, org_id, effective_date).await?;
    sqlx::query(
        r#"
        UPDATE employees
        SET
            company = $3,
            org_unit = $4,
            position = COALESCE($5, position),
            employment_status = $6,
            exit_on = CASE WHEN $6 = 'EXITED' THEN $7 ELSE NULL END,
            -- PA-DATE expand: the text pair is written too, so a legacy value
            -- the expand parser left undated is still cleared on reactivation.
            exit_date = CASE WHEN $6 = 'EXITED' THEN to_char($7, 'YYYY-MM-DD') ELSE NULL END,
            updated_at = now()
        WHERE org_id = $1 AND id = $2
        "#,
    )
    .bind(org_id)
    .bind(employee_id)
    .bind(change.company)
    .bind(change.org_unit)
    .bind(change.position)
    .bind(change.employment_status)
    .bind(effective_date)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Binds the legacy head to a canonical OrgUnit (`employees.org_unit_id`,
/// 0242), inside the caller's transaction. `org_unit_name`, when given, becomes
/// the read-only `employees.org_unit` projection existing readers keep using;
/// `None` leaves that text untouched (the port path, which stores UUID text).
///
/// # Errors
/// The driver error verbatim (a foreign/unknown unit fails the composite FK).
pub async fn set_employee_org_unit(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    org_unit_id: Option<Uuid>,
    org_unit_name: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE employees SET org_unit_id = $3, org_unit = COALESCE($4, org_unit), \
         updated_at = now() WHERE org_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(employee_id)
    .bind(org_unit_id)
    .bind(org_unit_name)
    .execute(tx.as_mut())
    .await
    .map(|_| ())
}

/// The name of an OrgUnit an employee may be bound to: visible in the armed
/// tenant (RLS — a foreign id is simply absent), kind Site/Department/Team,
/// and not dissolved. `None` for anything else. SELECT only.
///
/// # Errors
/// The driver error verbatim.
pub async fn assignable_org_unit_name(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    org_unit_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    Ok(assignable_org_units(tx, org_id, &[org_unit_id])
        .await?
        .remove(&org_unit_id)
        .flatten())
}

/// Visible units mapped to their assignable name, or `None` for non-assignable
/// units. Missing or foreign units are absent. Uses each unit's latest revision.
///
/// # Errors
/// The driver error verbatim, including an assignable unit with no name.
pub async fn assignable_org_units(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    org_unit_ids: &[Uuid],
) -> Result<HashMap<Uuid, Option<String>>, sqlx::Error> {
    if org_unit_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT u.id, latest.attributes->>'name' AS name, COALESCE( \
           latest.attributes->>'kind' IN ('site', 'department', 'team') \
           AND COALESCE(latest.attributes->>'status', 'active') <> 'dissolved', false) AS assignable \
         FROM org_units u LEFT JOIN LATERAL ( \
             SELECT attributes FROM org_unit_revisions r \
             WHERE r.org_id = u.org_id AND r.org_unit_id = u.id \
             ORDER BY r.version DESC LIMIT 1 \
         ) latest ON true \
         WHERE u.org_id = $1 AND u.id = ANY($2)",
    )
    .bind(org_id)
    .bind(org_unit_ids)
    .fetch_all(tx.as_mut())
    .await?;
    rows.into_iter()
        .map(|row| {
            let name = if row.try_get::<bool, _>("assignable")? {
                Some(row.try_get("name")?)
            } else {
                None
            };
            Ok((row.try_get("id")?, name))
        })
        .collect()
}

/// Assign registration units together; validation belongs to the registration preparation.
pub async fn set_employee_org_units(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    units: &[(Uuid, Uuid)],
) -> Result<(), sqlx::Error> {
    if !units.is_empty() {
        sqlx::query(
            "UPDATE employees e SET org_unit_id=r.unit,updated_at=now() \
            FROM unnest($2::uuid[],$3::uuid[]) r(id,unit) WHERE e.org_id=$1 AND e.id=r.id",
        )
        .bind(org)
        .bind(units.iter().map(|r| r.0).collect::<Vec<_>>())
        .bind(units.iter().map(|r| r.1).collect::<Vec<_>>())
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}
