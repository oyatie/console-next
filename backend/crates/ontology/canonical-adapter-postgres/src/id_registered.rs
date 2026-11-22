// SPDX-License-Identifier: LicenseRef-Proprietary
//! Canonical ownership helpers for `employees.id_type` updates and immutable `IdRegistered` events.

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::{DbError, insert_audit_event};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// Parameters for updating `employees.id_type` and recording an `IdRegistered` audit event when a
/// `PRE_HIRE` (`NOT_ISSUED`) worker transitions to an issued legal identifier.
#[derive(Debug, Clone)]
pub struct IdRegisteredWrite<'a> {
    pub org_id: Uuid,
    pub employee_id: Uuid,
    pub actor: Option<UserId>,
    pub new_id_type: &'a str,
    pub source: &'a str,
    pub trace: TraceContext,
}

/// Errors emitted while persisting `employees.id_type` or its `IdRegistered` audit event.
#[derive(Debug, thiserror::Error)]
pub enum IdTypeWriteError {
    #[error("not_issued_requires_pre_hire")]
    NotIssuedRequiresPreHire,
    #[error("database error: {0}")]
    Db(#[from] DbError),
}

impl From<sqlx::Error> for IdTypeWriteError {
    fn from(err: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(err))
    }
}

fn is_real_id_type(id_type: &str) -> bool {
    matches!(id_type, "RRN" | "ARC" | "DOMESTIC_RESIDENCE")
}

/// Emit an immutable `employee.id_registered` (`IdRegistered`) audit event in the active
/// transaction when `previous_id_type == Some("NOT_ISSUED")` transitions to a real identifier
/// (`RRN`, `ARC`, `DOMESTIC_RESIDENCE`).
///
/// # Errors
/// Returns [`IdTypeWriteError`] when audit persistence fails.
pub async fn emit_id_registered_if_transitioned(
    tx: &mut Transaction<'_, Postgres>,
    previous_id_type: Option<&str>,
    write: IdRegisteredWrite<'_>,
) -> Result<bool, IdTypeWriteError> {
    if previous_id_type != Some("NOT_ISSUED") || !is_real_id_type(write.new_id_type) {
        return Ok(false);
    }
    let action = AuditAction::new("employee.id_registered")
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    let event = AuditEvent::new(
        write.actor,
        action,
        "employee",
        write.employee_id.to_string(),
        write.trace,
        OffsetDateTime::now_utc(),
    )
    .with_org(OrgId::from_uuid(write.org_id))
    .with_snapshots(
        Some(json!({ "id_type": "NOT_ISSUED" })),
        Some(json!({
            "event_type": "IdRegistered",
            "previous_id_type": "NOT_ISSUED",
            "id_type": write.new_id_type,
            "source": write.source,
        })),
    );
    insert_audit_event(tx, &event).await?;
    Ok(true)
}

/// Lock the `employees` row, enforce `NOT_ISSUED` -> `PRE_HIRE` invariants, persist `id_type`, and
/// atomically emit an `IdRegistered` audit event when transitioning from `NOT_ISSUED`.
///
/// Returns `Ok(true)` if an `IdRegistered` event was emitted, `Ok(false)` otherwise.
///
/// # Errors
/// Returns [`IdTypeWriteError::NotIssuedRequiresPreHire`] when attempting to write `NOT_ISSUED` on
/// a non-`PRE_HIRE` employee, or [`IdTypeWriteError::Db`] on database failures.
pub async fn set_employee_id_type_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    write: IdRegisteredWrite<'_>,
) -> Result<bool, IdTypeWriteError> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT employment_status, id_type FROM employees WHERE org_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(write.org_id)
    .bind(write.employee_id)
    .fetch_optional(tx.as_mut())
    .await?;

    let Some((status, previous_id_type)) = row else {
        return Ok(false);
    };
    if write.new_id_type == "NOT_ISSUED" && status != "PRE_HIRE" {
        return Err(IdTypeWriteError::NotIssuedRequiresPreHire);
    }
    if previous_id_type.as_deref() != Some(write.new_id_type) {
        sqlx::query(
            "UPDATE employees SET id_type = $3, updated_at = now() WHERE org_id = $1 AND id = $2",
        )
        .bind(write.org_id)
        .bind(write.employee_id)
        .bind(write.new_id_type)
        .execute(tx.as_mut())
        .await?;
    }
    emit_id_registered_if_transitioned(tx, previous_id_type.as_deref(), write).await
}

/// Revert `employees.id_type` on updated employees whose `employee_rrn` was recorded by `run_id`,
/// preserving `'NOT_ISSUED'` when an `employee.id_registered` event was emitted for a `PRE_HIRE`
/// worker during the run and clearing `id_type` to `NULL` otherwise.
///
/// Must run in the rollback transaction before `import_api.remove_employee_import_effects` deletes
/// the `employee_rrn` rows owned by `run_id`.
///
/// # Errors
/// Returns [`IdTypeWriteError::Db`] on database failures.
pub async fn revert_import_id_type_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    run_id: Uuid,
    updated_employee_ids: &[Uuid],
) -> Result<(), IdTypeWriteError> {
    if updated_employee_ids.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "UPDATE employees e \
         SET id_type = CASE \
                 WHEN e.employment_status = 'PRE_HIRE' \
                      AND EXISTS ( \
                          SELECT 1 FROM audit_events a \
                          JOIN data_import_runs r ON r.org_id = e.org_id AND r.id = $2 \
                          WHERE a.org_id = e.org_id \
                            AND a.target_type = 'employee' \
                            AND a.target_id = e.id::TEXT \
                            AND a.action = 'employee.id_registered' \
                            AND (r.applied_at IS NULL OR a.occurred_at >= r.applied_at - interval '1 minute') \
                      ) \
                 THEN 'NOT_ISSUED' \
                 ELSE NULL \
             END, \
             updated_at = now() \
         FROM import_run_effects f \
         JOIN employee_rrn er \
           ON er.org_id = f.org_id \
          AND er.employee_id = f.target_id \
          AND er.import_run_id = f.run_id \
         WHERE f.org_id = $1 \
           AND f.run_id = $2 \
           AND f.effect = 'rrn_recorded' \
           AND e.org_id = f.org_id \
           AND e.id = f.employee_id \
           AND e.id = ANY($3) \
           AND e.voided_at IS NULL",
    )
    .bind(org_id)
    .bind(run_id)
    .bind(updated_employee_ids)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
