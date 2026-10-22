//! MR-22: the 법인 · 사업장 assignment is written with the registration, in
//! its transaction, so one call records the person and where they work (no
//! second call that can fail after the person exists).
//!
//! The 사업장 is the one asked for (`workplace_id`), else the one the chosen
//! unit sits in. Neither: the person is 미배치 (no assignment), placed later.

use console_entity_adapter_postgres::employment_hire::{hire_in_tx, unit_placement};
use console_entity_adapter_postgres::employment_moves::MoveWrite;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::KernelError;
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::directory::types::NormalizedCreateEmployeeRequest;
use crate::lifecycle::title_reason::coded;

fn refused(code: &'static str, message: &str) -> HrError {
    coded(KernelError::validation(message.to_owned()).with_code(code))
}

/// Places the just-registered `employee_id`; `None` when nothing names a
/// 사업장 (미배치).
///
/// # Errors
/// 422 `workplace_required` (a 법인 without a 사업장), `org_unit_at_other_workplace`,
/// `workplace_of_other_entity`, `workplace_not_open`, `home_branch_not_workplace`
/// (a home branch that is not the 사업장's); a database fault.
pub async fn place_registration(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    employee_id: Uuid,
    request: &NormalizedCreateEmployeeRequest,
) -> Result<Option<Uuid>, HrError> {
    if request.legal_entity_id.is_some() && request.workplace_id.is_none() {
        return Err(refused(
            "workplace_required",
            "name the 사업장 the person works at with the 법인",
        ));
    }
    let at_unit = match request.org_unit_id {
        Some(unit) => unit_placement(tx.as_mut(), org, unit)
            .await
            .map_err(coded)?,
        None => None,
    };
    if let (Some(asked), Some(at)) = (request.workplace_id, at_unit)
        && asked != at.workplace_id
    {
        return Err(refused(
            "org_unit_at_other_workplace",
            "the unit sits at another 사업장 than workplace_id",
        ));
    }
    let Some(workplace) = request.workplace_id.or(at_unit.map(|p| p.workplace_id)) else {
        return Ok(None);
    };
    let hire = request
        .hire_date
        .as_deref()
        .ok_or_else(|| HrError::validation("hire_date is required"))
        .and_then(|day| parse_yyyy_mm_dd(day).map_err(HrError::from_kernel))?;
    let write = MoveWrite {
        org_id: org,
        employee_id,
        actor_id: actor,
        command_id: Uuid::new_v4(),
    };
    let placed = hire_in_tx(tx.as_mut(), write, workplace, hire)
        .await
        .map_err(coded)?;
    if request
        .legal_entity_id
        .is_some_and(|entity| entity != placed.legal_entity_id)
    {
        return Err(refused(
            "workplace_of_other_entity",
            "the 사업장 belongs to another 법인 than legal_entity_id",
        ));
    }
    if workplace_branch(tx.as_mut(), org, placed.workplace_id)
        .await?
        .is_some_and(|branch| Some(branch) != request.home_branch_id)
    {
        return Err(branch_refused());
    }
    Ok(Some(placed.workplace_id))
}

/// UX-R1 PLACEMENT (org-19, worst-case-32): the legacy 소속 지점 is the
/// 사업장's own branch and never says otherwise: 422
/// `home_branch_not_workplace` (field `home_branch_id`).
pub fn branch_refused() -> HrError {
    let mut error = refused(
        "home_branch_not_workplace",
        "the home branch is the 사업장's own branch; move the person with a 전보 to change it",
    );
    error.refusals = Some(Box::new(serde_json::json!([{
        "field": "home_branch_id",
        "code": "home_branch_not_workplace",
    }])));
    error
}

/// The branch backing `workplace` (its `default_branch_id`), if it has one.
///
/// # Errors
/// A database fault.
pub async fn workplace_branch(
    conn: &mut sqlx::PgConnection,
    org: Uuid,
    workplace: Uuid,
) -> Result<Option<Uuid>, HrError> {
    let branch: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT default_branch_id FROM workplaces WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(workplace)
    .fetch_optional(conn)
    .await?;
    Ok(branch.flatten())
}
