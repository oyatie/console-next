//! Employee → natural person. Entries hang off `persons`; the binding comes
//! from directory create, or is minted here through the Person port
//! (`write_in_tx`, `person_id = employee_id`) on an employee's first write,
//! because the import path does not mint one.

use console_kernel_core::{KernelError, OrgId, UserId};
use console_ontology_canonical_adapter_postgres::person::{PersonCommand, write_in_tx};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::HrError;

fn employee_not_found() -> HrError {
    HrError::from_kernel(KernelError::not_found(
        "employee was not found in this organization",
    ))
}

async fn lookup(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    lock: bool,
) -> Result<(String, Option<Uuid>), HrError> {
    let sql = if lock {
        "SELECT e.name, b.person_id FROM employees e LEFT JOIN employee_person_bindings b \
         ON b.org_id = e.org_id AND b.employee_id = e.id WHERE e.org_id = $1 AND e.id = $2 FOR UPDATE OF e"
    } else {
        "SELECT e.name, b.person_id FROM employees e LEFT JOIN employee_person_bindings b \
         ON b.org_id = e.org_id AND b.employee_id = e.id WHERE e.org_id = $1 AND e.id = $2"
    };
    let row = sqlx::query(sql)
        .bind(org)
        .bind(employee)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(employee_not_found)?;
    Ok((row.try_get("name")?, row.try_get("person_id")?))
}

/// The person an employee is bound to; `None` when there is none yet. 404
/// when the employee is not in this tenant.
pub(crate) async fn bound_person(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
) -> Result<Option<Uuid>, HrError> {
    Ok(lookup(tx, org, employee, false).await?.1)
}

/// The employee's person, minted and bound when missing, then locked for
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
    let org_uuid = *org.as_uuid();
    let person = match bound_person(tx, org_uuid, employee).await? {
        Some(person) => person,
        None => {
            // The employee row lock serialises two first writes.
            match lookup(tx, org_uuid, employee, true).await? {
                (_, Some(person)) => person,
                (name, None) => {
                    write_in_tx(
                        tx,
                        &PersonCommand::create_bound(org, actor, employee, &name),
                    )
                    .await?;
                    employee
                }
            }
        }
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('person_record:' || $1::text, 0))")
        .bind(person)
        .execute(tx.as_mut())
        .await?;
    Ok(person)
}
