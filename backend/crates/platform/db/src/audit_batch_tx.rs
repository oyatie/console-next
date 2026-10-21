//! Audited batches, with an exclusive phase lock for setup choices and transitions.
use console_kernel_core::{AuditEvent, OrgId};
use sqlx::{PgPool, Postgres, Transaction};

use crate::DbError;
use crate::audit_tx::set_current_org;
use crate::audit_write::insert_audit_event_tx;

/// Execute a mutation closure that returns one or more audit events computed
/// from rows locked inside the same transaction.
///
/// Use this when the audit snapshots cannot be known before `SELECT FOR UPDATE`,
/// or when a single business action intentionally updates multiple audited
/// targets atomically.
///
/// # Tenant binding (mandatory)
/// `org` is bound to the transaction-local `app.current_org` GUC immediately
/// after `begin()`, before the caller's closure runs — exactly like
/// [`crate::with_audit`] does from `event.org_id`. Unlike `with_audit` the tenant here
/// is a REQUIRED parameter: a multi-statement audited mutation must never open
/// its transaction without arming the org, or its writes would hit Postgres RLS
/// with an unset GUC and fail closed (or, worse, on a not-yet-RLS table, run
/// untenanted). Passing the org explicitly makes that impossible to forget.
pub async fn with_audits<F, T, E>(pool: &PgPool, org: OrgId, f: F) -> Result<T, E>
where
    F: for<'tx> FnOnce(
        &'tx mut Transaction<'_, Postgres>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(T, Vec<AuditEvent>), E>> + Send + 'tx>,
    >,
    E: From<DbError>,
{
    with_audits_inner(pool, org, false, f).await
}

/// Run an audited mutation that locks or changes the tenant phase.
///
/// Take the exclusive phase lock before admission captures its shared lock; upgrading
/// two concurrent admission locks would deadlock. Other audited commands retain shared admission.
/// # Errors
/// Returns transaction, mutation, or audit failures without committing business changes.
pub async fn with_phase_audits<F, T, E>(pool: &PgPool, org: OrgId, f: F) -> Result<T, E>
where
    F: for<'tx> FnOnce(
        &'tx mut Transaction<'_, Postgres>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(T, Vec<AuditEvent>), E>> + Send + 'tx>,
    >,
    E: From<DbError>,
{
    with_audits_inner(pool, org, true, f).await
}

async fn with_audits_inner<F, T, E>(
    pool: &PgPool,
    org: OrgId,
    lock_phase: bool,
    f: F,
) -> Result<T, E>
where
    F: for<'tx> FnOnce(
        &'tx mut Transaction<'_, Postgres>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(T, Vec<AuditEvent>), E>> + Send + 'tx>,
    >,
    E: From<DbError>,
{
    let mut tx = pool.begin().await.map_err(|e| E::from(DbError::begin(e)))?;
    set_current_org(&mut tx, org).await.map_err(E::from)?;
    crate::command_outcomes::lock_current(&mut tx)
        .await
        .map_err(E::from)?;
    if lock_phase {
        sqlx::query("SELECT phase FROM tenant_phase WHERE org_id = $1 FOR UPDATE")
            .bind(org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await
            .map_err(|e| E::from(DbError::Sqlx(e)))?;
    }
    let context = crate::command_context::prepare_transaction(&mut tx, org)
        .await
        .map_err(E::from)?;
    let result = f(&mut tx).await;

    match result {
        Err(e) => {
            let _ = tx.rollback().await;
            Err(e)
        }
        Ok((value, mut events)) => {
            for event in &mut events {
                event.command_context =
                    Some(crate::command_context::for_event(context.clone(), event));
                crate::command_context::remember(event);
                insert_audit_event_tx(&mut tx, event)
                    .await
                    .map_err(E::from)?;
            }
            crate::command_outcomes::settle_applied(&mut tx, &events)
                .await
                .map_err(E::from)?;
            tx.commit().await.map_err(|e| E::from(DbError::Sqlx(e)))?;
            Ok(value)
        }
    }
}
