//! BW-19 1-3: the checks a People & Workforce registration meets before it
//! writes: a taken 사번 names its holder (any status), a person already on
//! file is named instead of silently duplicated (`create_duplicates.rs`), and
//! the two unique-violation causes get distinct codes. Same name and hire date
//! is only a warning: two people of one name starting on one day is
//! legitimate (P5-NS-01).

use console_ontology_canonical_adapter_postgres::employee_void::include_voided;
use serde_json::json;
use sqlx::Postgres;
use uuid::Uuid;

use http::StatusCode;

use crate::HrError;
use crate::directory::create_duplicates::{
    DuplicateOverride, admit_duplicates, duplicate_candidates,
};
use crate::directory::types::{EmployeeCreateWarning, NormalizedCreateEmployeeRequest};

/// 409 `employee_number_taken`, naming the holder (any status).
pub fn employee_number_taken(holder: Option<(Uuid, String)>) -> HrError {
    HrError {
        errors: None,
        status: StatusCode::CONFLICT,
        code: "employee_number_taken",
        message: "employee number is already held by another employee".to_owned(),
        refusals: Some(Box::new(json!(
            holder
                .map(|(id, status)| vec![json!({ "holder": { "id": id, "status": status } })])
                .unwrap_or_default()
        ))),
    }
}

/// True when this registration's idempotency key already names a created
/// employee: the core replays it, so the pre-write checks must not refuse it.
pub async fn is_replay(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    idempotency_key: &str,
) -> Result<bool, HrError> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM employee_create_idempotency \
         WHERE org_id = $1 AND idempotency_key = $2 AND employee_id IS NOT NULL)",
    )
    .bind(org_uuid)
    .bind(idempotency_key)
    .fetch_one(tx.as_mut())
    .await?)
}

/// The holder of `employee_number` in this tenant, any status, a voided
/// registration included (it keeps its 사번, decisions #6; MR-26).
pub async fn employee_number_holder(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_number: &str,
) -> Result<Option<(Uuid, String)>, HrError> {
    include_voided(tx, true).await?;
    let holder = sqlx::query_as(
        "SELECT id, employment_status FROM employees \
         WHERE org_id = $1 AND employee_number = $2 ORDER BY created_at LIMIT 1",
    )
    .bind(org_uuid)
    .bind(employee_number)
    .fetch_optional(tx.as_mut())
    .await?;
    include_voided(tx, false).await?;
    Ok(holder)
}

/// The pre-write checks of a People & Workforce registration (the recruiting
/// hire handshake has its own candidate and never meets them). A replay of a
/// created registration skips them: the core returns the stored employee.
/// Returns the duplicate override the registration was admitted under; its
/// exception is recorded once the employee exists (`create_exception.rs`).
///
/// # Errors
/// 409 `employee_number_taken` (with the holder) or `duplicate_candidate`;
/// 422 for an override that names no reason or a stranger.
pub async fn registration_checks(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    request: &NormalizedCreateEmployeeRequest,
) -> Result<Option<DuplicateOverride>, HrError> {
    if is_replay(tx, org_uuid, &request.idempotency_key).await? {
        return Ok(None);
    }
    if !request.employee_number.is_empty()
        && let Some(holder) = employee_number_holder(tx, org_uuid, &request.employee_number).await?
    {
        return Err(employee_number_taken(Some(holder)));
    }
    let candidates = duplicate_candidates(tx, org_uuid, request).await?;
    Ok(admit_duplicates(&candidates, request.duplicate_override.as_ref())?.cloned())
}

/// `same_name_same_hire_date`: others of the same name (spaces ignored) hired
/// the same day. A notice only.
pub async fn same_name_same_hire_date_warning(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_id: Uuid,
    name: &str,
    hire_date: Option<&str>,
) -> Result<Option<EmployeeCreateWarning>, HrError> {
    let Some(hire_date) = hire_date else {
        return Ok(None);
    };
    let employee_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM employees WHERE org_id = $1 AND id <> $2 \
           AND merged_into_employee_id IS NULL \
           AND regexp_replace(name, '\\s', '', 'g') = regexp_replace($3, '\\s', '', 'g') \
           AND hire_date::TEXT = $4 ORDER BY id",
    )
    .bind(org_uuid)
    .bind(employee_id)
    .bind(name)
    .bind(hire_date)
    .fetch_all(tx.as_mut())
    .await?;
    if employee_ids.is_empty() {
        return Ok(None);
    }
    Ok(Some(EmployeeCreateWarning {
        code: "same_name_same_hire_date",
        employee_ids,
        floor_won: None,
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_taken_number_names_its_holder() {
        let id = Uuid::new_v4();
        let taken = employee_number_taken(Some((id, "EXITED".to_owned())));
        assert_eq!(
            (taken.status.as_u16(), taken.code),
            (409, "employee_number_taken")
        );
        assert_eq!(taken.refusals.unwrap()[0]["holder"]["status"], "EXITED");
    }
}
