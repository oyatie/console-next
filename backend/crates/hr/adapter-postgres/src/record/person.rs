//! Record writes require the Person binding established at employee creation.

use console_kernel_core::{KernelError, OrgId, UserId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::HrError;

fn employee_not_found() -> HrError {
    HrError::from_kernel(KernelError::not_found(
        "employee was not found in this organization",
    ))
}

/// The existing binding; a missing employee is 404, an unbound employee is None.
pub(crate) async fn bound_person(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
) -> Result<Option<Uuid>, HrError> {
    sqlx::query_scalar(
        "SELECT b.person_id FROM employees e LEFT JOIN employee_person_bindings b \
        ON b.org_id=e.org_id AND b.employee_id=e.id WHERE e.org_id=$1 AND e.id=$2",
    )
    .bind(org)
    .bind(employee)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(employee_not_found)
}

/// The employee's already-bound person, locked for
/// this transaction so concurrent writes to one person serialise (the
/// version and the one-live-병역 checks read what they write).
pub(crate) async fn writable_person(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Uuid,
) -> Result<Uuid, HrError> {
    // people-self-33: every 인사기록카드 write (and its import) meets the self rule.
    crate::own_record::own_record_guard(
        tx,
        org,
        actor,
        employee,
        console_platform_authz::Feature::EmployeeDirectoryManage,
    )
    .await?;
    crate::employee_state::require_editable(tx.as_mut(), *org.as_uuid(), employee).await?;
    let org_uuid = *org.as_uuid();
    let person = bound_person(tx, org_uuid, employee).await?.ok_or_else(|| {
        crate::corrections::refusal(
            http::StatusCode::CONFLICT,
            "person_binding_required",
            "this employee requires a Person binding review before record changes",
        )
    })?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('person_record:' || $1::text, 0))")
        .bind(person)
        .execute(tx.as_mut())
        .await?;
    Ok(person)
}
