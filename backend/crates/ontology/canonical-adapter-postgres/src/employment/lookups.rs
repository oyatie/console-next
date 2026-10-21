//! SELECT-only reference and binding lookups, RLS-scoped by the caller's transaction.

use super::error::EmploymentError;
use super::model::EmploymentAttributes;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// The name on an OrgUnit's latest revision; `None` when it has none. SELECT
/// only, RLS-scoped by the caller's armed transaction.
pub(super) async fn org_unit_name(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    org_unit_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    Ok(sqlx::query_scalar(
        "SELECT attributes->>'name' FROM org_unit_revisions \
         WHERE org_id = $1 AND org_unit_id = $2 ORDER BY version DESC LIMIT 1",
    )
    .bind(org_id)
    .bind(org_unit_id)
    .fetch_optional(tx.as_mut())
    .await?
    .flatten())
}

pub(super) async fn employment_id_for_employee(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
) -> Result<Uuid, EmploymentError> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT employment_id FROM employment_source_bindings \
         WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(org_id)
    .bind(employee_id)
    .fetch_all(tx.as_mut())
    .await?;
    match rows.as_slice() {
        [] => Err(EmploymentError::UnboundEmployeeForTransfer { employee_id }),
        [employment_id] => Ok(*employment_id),
        _ => Err(EmploymentError::AmbiguousSourceBinding {
            employment_id: rows[0],
            binding_count: rows.len(),
        }),
    }
}

pub(super) async fn ensure_attribute_refs(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    attributes: &EmploymentAttributes,
) -> Result<(), EmploymentError> {
    if let Some(org_unit_id) = attributes.org_unit_id {
        ensure_org_unit_exists(tx, org_id, org_unit_id).await?;
    }
    if let Some(job_position_id) = attributes.job_position_id {
        ensure_job_position_exists(tx, org_id, job_position_id).await?;
    }
    Ok(())
}

pub async fn ensure_org_unit_exists(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    org_unit_id: Uuid,
) -> Result<(), EmploymentError> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM org_units WHERE org_id = $1 AND id = $2)")
            .bind(org_id)
            .bind(org_unit_id)
            .fetch_one(tx.as_mut())
            .await?;
    if exists {
        Ok(())
    } else {
        Err(EmploymentError::UnknownOrgUnit(org_unit_id))
    }
}

pub async fn ensure_job_position_exists(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    job_position_id: Uuid,
) -> Result<(), EmploymentError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM job_positions WHERE org_id = $1 AND id = $2)",
    )
    .bind(org_id)
    .bind(job_position_id)
    .fetch_one(tx.as_mut())
    .await?;
    if exists {
        Ok(())
    } else {
        Err(EmploymentError::UnknownJobPosition(job_position_id))
    }
}

/// The legacy `employees` row this employment IS, read through the binding.
///
/// `RowNotFound` when nothing is bound is deliberate: a promotion whose legacy
/// head cannot be found must fail the whole command rather than append a
/// canonical revision the rest of the tree cannot see. Multiple bindings for
/// the same `employment_id` are refused — `fetch_one` would silently pick.
pub(super) async fn bound_employee(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    employment_id: Uuid,
) -> Result<Uuid, EmploymentError> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT employee_id FROM employment_source_bindings \
         WHERE org_id = $1 AND employment_id = $2",
    )
    .bind(org_id)
    .bind(employment_id)
    .fetch_all(tx.as_mut())
    .await?;
    match rows.as_slice() {
        [] => Err(EmploymentError::Database(sqlx::Error::RowNotFound)),
        [employee_id] => Ok(*employee_id),
        _ => Err(EmploymentError::AmbiguousSourceBinding {
            employment_id,
            binding_count: rows.len(),
        }),
    }
}
