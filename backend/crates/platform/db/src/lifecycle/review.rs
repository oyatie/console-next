// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{
    DISPOSED_STATE, DbError, KernelError, LifecycleRecord, enforce_maker_checker, internal,
    is_checker_transition,
};
use console_kernel_core::ErrorKind;
use sqlx::{Postgres, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

/// Only rule-defined successors available to this actor at the time of the read.
/// The mutation repeats the same checks under the lifecycle row lock.
pub async fn available_transitions(
    tx: &mut Transaction<'_, Postgres>,
    record: &LifecycleRecord,
    actor: Uuid,
    today: Date,
) -> Result<Vec<String>, KernelError> {
    let candidates: Vec<String> = sqlx::query_scalar("SELECT to_state FROM lifecycle_transition_rules WHERE object_type=$1 AND from_state=$2 ORDER BY to_state")
        .bind(&record.object_type).bind(&record.current_state).fetch_all(tx.as_mut()).await.map_err(|e| internal(DbError::Sqlx(e)))?;
    let mut allowed = Vec::new();
    for candidate in candidates {
        match check_restrictions(tx, record, &candidate, Some(actor), today).await {
            Ok(()) => allowed.push(candidate),
            Err(e) if matches!(e.kind, ErrorKind::Forbidden | ErrorKind::Conflict) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(allowed)
}

/// Hold writes replace both flags. A client that read the record may require that
/// revision to prevent an intervening hold or retention update from being overwritten.
pub async fn require_current_revision(
    tx: &mut Transaction<'_, Postgres>,
    object_type: &str,
    object_id: Uuid,
    revision: OffsetDateTime,
) -> Result<(), KernelError> {
    let id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM object_lifecycles WHERE object_type=$1 AND object_id=$2 AND updated_at=$3 FOR UPDATE")
        .bind(object_type).bind(object_id).bind(revision).fetch_optional(tx.as_mut()).await.map_err(|e|internal(DbError::Sqlx(e)))?;
    if id.is_none() {
        return Err(KernelError::conflict("lifecycle changed since it was read"));
    }
    Ok(())
}

pub(super) async fn check_restrictions(
    tx: &mut Transaction<'_, Postgres>,
    current: &LifecycleRecord,
    to_state: &str,
    actor: Option<Uuid>,
    today: Date,
) -> Result<(), KernelError> {
    // Maker–checker (SoD): the approver must not be the drafter.
    if is_checker_transition(&current.object_type, &current.current_state, to_state) {
        enforce_maker_checker(tx, current, actor).await?;
    }

    // Dispose gate: legal hold and retention fail closed.
    if to_state == DISPOSED_STATE {
        if current.legal_hold {
            return Err(KernelError::conflict(format!(
                "{} {} is under legal hold; dispose refused",
                current.object_type, current.object_id
            )));
        }
        if let Some(retention_until) = current.retention_until
            && retention_until > today
        {
            return Err(KernelError::conflict(format!(
                "{} {} is retained until {retention_until}; dispose refused",
                current.object_type, current.object_id
            )));
        }
    }

    Ok(())
}
