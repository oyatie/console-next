//! UX-R2 ENDS: the lifecycle tick's 사업장 close step. A close job whose
//! 폐쇄일 has come (or that WAITED for its 퇴직 to take effect) is advanced
//! by HR's `lifecycle::close_plan`, after the tick has applied the day's
//! scheduled lifecycle events. Both roles run it (the dev/E2E launcher starts
//! only the api role); jobs are claimed `FOR UPDATE SKIP LOCKED`.

use time::Date;

/// Advance the due close jobs of every tenant; logs, never fails the tick.
pub(crate) async fn tick(pool: &sqlx::PgPool, today: Date) {
    let hr = console_hr_adapter_postgres::HrService::new(pool.clone());
    match hr
        .advance_due_workplace_closes(today, crate::entity_wiring::org_unit_port())
        .await
    {
        Ok(0) => {}
        Ok(closed) => tracing::info!(closed, "workplace close jobs applied"),
        Err(error) => tracing::warn!(%error, "workplace close run failed"),
    }
}
