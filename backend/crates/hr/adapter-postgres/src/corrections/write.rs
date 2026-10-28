//! Applying corrected values: the checks that need the locked record, the
//! writes (the `employees` head through its canonical owner, the profile
//! here), and one ledger row per field. Every path that changes a scalar
//! employee field ends here: the PATCH, an applied PROFILE_CORRECTION and the
//! facts PATCH.

use console_hr_domain::profile::facts::validate_probation_end;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_ontology_canonical_adapter_postgres::employee_correction::{
    correct_employee_head_in_tx, restore_import_employee_head_in_tx,
};
use console_ontology_canonical_adapter_postgres::employee_void::include_voided;
use http::StatusCode;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::head::LockedEmployee;
use super::profile::{self, PROFILE_FIELDS};
use super::refusal;
use crate::HrError;
use crate::{personal_facts, register_facts};

/// A normalized `(field, value)`; `None` clears the field.
pub(crate) type FieldValue = (String, Option<String>);

/// Who applied a correction, why, and through which request.
pub(crate) struct LedgerMeta<'a> {
    pub import_run_id: Option<Uuid>,
    pub reason_code: &'a str,
    pub note: Option<&'a str>,
    pub corrected_by: Uuid,
    pub change_request_id: Option<Uuid>,
    pub review_required: bool,
    /// The bulk 정정 job the row belongs to (MR-27).
    pub batch_id: Option<Uuid>,
}

fn value_of<'a>(fields: &'a [FieldValue], name: &str) -> Option<Option<&'a str>> {
    fields
        .iter()
        .find(|(field, _)| field == name)
        .map(|(_, value)| value.as_deref())
}

fn day(raw: Option<&str>) -> Option<time::Date> {
    raw.and_then(|raw| parse_yyyy_mm_dd(raw.trim()).ok())
}

/// The checks a value cannot pass on its own: an exit date only on an exited
/// record without an exit case, dates in order, a free 사번, a pay unit with a
/// pay, an open probation.
pub(crate) async fn check_against_record(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    head: &LockedEmployee,
    fields: &[FieldValue],
) -> Result<(), HrError> {
    super::catalog::check_in_tx(tx, org, fields).await?;
    register_facts::store::check_in_tx(
        tx,
        org,
        employee_id,
        &head.employment_status,
        value_of(fields, "exit_reason").flatten(),
    )
    .await?;
    if let Some(contacts) = value_of(fields, "emergency_contacts") {
        personal_facts::store::contact_plan(tx, org, employee_id, contacts).await?;
    }
    let hire = value_of(fields, "hire_date").map_or(day(head.hire_date.as_deref()), day);
    // Only when either date changes: a record that already disagrees must not
    // block an unrelated correction.
    let group = match value_of(fields, "group_service_start_date") {
        Some(group) => group,
        None if value_of(fields, "hire_date").is_some() => {
            head.personal.stored("group_service_start_date")
        }
        None => None,
    };
    let photo = value_of(fields, "photo").flatten();
    personal_facts::store::check_in_tx(tx, org, employee_id, hire, group, photo).await?;
    if let Some(Some(exit)) = value_of(fields, "exit_date") {
        if head.employment_status != "EXITED" {
            return Err(refusal(
                StatusCode::CONFLICT,
                "exit_date_needs_exit",
                "only an exited record's 퇴직일 is corrected; an exit is reported through the exit case",
            ));
        }
        let live_case: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM employee_exit_cases WHERE org_id = $1 AND employee_id = $2 \
             AND status NOT IN ('REJECTED', 'CANCELLED'))",
        )
        .bind(org)
        .bind(employee_id)
        .fetch_one(tx.as_mut())
        .await?;
        if live_case {
            return Err(refusal(
                StatusCode::CONFLICT,
                "exit_case_owns_exit_date",
                "this exit was reported through an exit case; correct the date there (날짜 정정 요청)",
            ));
        }
        if hire.is_some_and(|hire| day(Some(exit)) < Some(hire)) {
            return Err(HrError::validation(
                "exit_date must be on or after the hire date",
            ));
        }
    }
    if let Some(Some(number)) = value_of(fields, "employee_number") {
        // The 0172 insert trigger's lock key, so a concurrent create waits.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1::text || ':' || $2))")
            .bind(org)
            .bind(number)
            .execute(tx.as_mut())
            .await?;
        // A voided registration keeps its 사번 (decisions #6), so it counts.
        include_voided(tx, true).await?;
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM employees WHERE org_id = $1 AND employee_number = $2 AND id <> $3)",
        )
        .bind(org)
        .bind(number)
        .bind(employee_id)
        .fetch_one(tx.as_mut())
        .await?;
        include_voided(tx, false).await?;
        if taken {
            return Err(refusal(
                StatusCode::CONFLICT,
                "employee_number_in_use",
                "another employee already holds this employee number",
            ));
        }
    }
    let Some(current) = head.profile.as_ref() else {
        return Ok(());
    };
    if value_of(fields, "pay_unit").is_some()
        && current.pay_unit.is_none()
        && value_of(fields, "base_pay").is_none()
    {
        return Err(HrError::validation(
            "pay_unit is recorded together with base_pay",
        ));
    }
    if let Some(end) = value_of(fields, "probation_end_date") {
        match day(end) {
            Some(end) => validate_probation_end(end, hire, current.probation_confirmed)
                .map_err(HrError::from_kernel)?,
            None if current.probation_confirmed => {
                return Err(HrError::from_kernel(
                    console_kernel_core::KernelError::invalid_transition(
                        "probation is already confirmed as ended; it cannot be removed",
                    ),
                ));
            }
            None => {}
        }
    }
    Ok(())
}

/// The ledger's old value: NULL for a first recording; a register item's
/// address or career list as JSON.
fn ledger_old(head: &LockedEmployee, field: &str) -> Option<serde_json::Value> {
    head.current(field)
        .map(|old| ledger_value(field, Some(old)))
}

/// A stored value as the ledger (and a bulk plan's comparison) sees it.
pub(crate) fn ledger_value(field: &str, value: Option<&str>) -> serde_json::Value {
    if register_facts::is_register_field(field) {
        register_facts::ledger_value(field, value)
    } else if personal_facts::is_personal_field(field) {
        personal_facts::ledger_value(field, value)
    } else {
        json!(value)
    }
}

/// Applies normalized `(field, value)` pairs to the locked record and writes
/// one ledger row per field. Returns the new `updated_at`.
pub(crate) async fn apply_fields_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    head: &LockedEmployee,
    fields: &[FieldValue],
    meta: &LedgerMeta<'_>,
) -> Result<OffsetDateTime, HrError> {
    check_against_record(tx, org, employee_id, head, fields).await?;
    let (personal, rest): (Vec<&FieldValue>, Vec<&FieldValue>) = fields
        .iter()
        .partition(|(field, _)| personal_facts::is_personal_field(field));
    if !personal.is_empty() {
        let items: Vec<(&str, Option<&str>)> = personal
            .iter()
            .map(|(field, value)| (field.as_str(), value.as_deref()))
            .collect();
        personal_facts::store::write_in_tx(tx, org, employee_id, &items, meta.corrected_by).await?;
    }
    let (register, fields_rest): (Vec<&FieldValue>, Vec<&FieldValue>) = rest
        .into_iter()
        .partition(|(field, _)| register_facts::is_register_field(field));
    if !register.is_empty() {
        let items: Vec<(&str, Option<&str>)> = register
            .iter()
            .map(|(field, value)| (field.as_str(), value.as_deref()))
            .collect();
        let (actor, note) = (meta.corrected_by, meta.note);
        register_facts::store::write_in_tx(tx, org, employee_id, &items, actor, note).await?;
    }
    let (profile_fields, head_fields): (Vec<&FieldValue>, Vec<&FieldValue>) = fields_rest
        .into_iter()
        .partition(|(field, _)| PROFILE_FIELDS.contains(&field.as_str()));
    if !profile_fields.is_empty() {
        profile::update_in_tx(tx, org, employee_id, head.profile.is_some(), |name| {
            value_of(fields, name).map(|value| value.map(str::to_owned))
        })
        .await?;
    }
    let columns: Vec<(&str, Option<&str>)> = head_fields
        .iter()
        .map(|(field, value)| (field.as_str(), value.as_deref()))
        .collect();
    // An empty column list still bumps updated_at: a profile-only 정정 moves
    // the record's version too.
    let updated_at = if meta.import_run_id.is_some() {
        restore_import_employee_head_in_tx(tx, org, employee_id, &columns).await?
    } else {
        correct_employee_head_in_tx(tx, org, employee_id, &columns).await?
    };
    if let (Some(_), Some(old)) = (
        value_of(fields, "employee_number"),
        head.current("employee_number"),
    ) {
        resolve_number_conflict(tx, org, old, meta.corrected_by).await?;
    }
    for (field, value) in fields {
        sqlx::query(
            "INSERT INTO employee_corrections (org_id, employee_id, field, old_value, new_value, \
             reason_code, note, corrected_by, change_request_id, review_required, batch_id, import_run_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        )
        .bind(org)
        .bind(employee_id)
        .bind(field)
        .bind(ledger_old(head, field))
        .bind(ledger_value(field, value.as_deref()))
        .bind(meta.reason_code)
        .bind(meta.note)
        .bind(meta.corrected_by)
        .bind(meta.change_request_id)
        .bind(meta.review_required)
        .bind(meta.batch_id)
        .bind(meta.import_run_id)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(updated_at)
}

/// MR-28: once no legacy-flagged holder of `number` is left, the BW-10
/// listing (0274 `employee_number_conflicts`) records the group resolved by
/// the person whose 정정 settled it. A voided holder stays hidden: a void
/// needs no cleanup.
async fn resolve_number_conflict(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    number: &str,
    by: Uuid,
) -> Result<(), HrError> {
    sqlx::query(
        "UPDATE employee_number_conflicts SET resolved_at = now(), resolved_by = $3 \
         WHERE org_id = $1 AND employee_number = $2 AND resolved_at IS NULL \
           AND NOT EXISTS (SELECT 1 FROM employees WHERE org_id = $1 AND employee_number = $2 \
                           AND employee_number_legacy_duplicate)",
    )
    .bind(org)
    .bind(number)
    .bind(by)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
