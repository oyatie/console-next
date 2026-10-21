//! Planner statistics after a bulk apply (migration `hr_import_refresh_planner_statistics`).
//!
//! An apply adds hundreds or thousands of rows to the tables the as-of membership read joins;
//! reads planned before autovacuum's next analyze can run for tens of seconds on stale
//! statistics. Best effort: a failed refresh is logged and never fails the import.

use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use sqlx::PgPool;

use crate::HrError;

/// Rows an apply must add before the refresh runs: below this, the load cannot move the
/// statistics enough to change a plan, and autovacuum keeps up.
pub(crate) const REFRESH_MIN_ROWS: usize = 100;

pub(crate) async fn refresh_after_apply(pool: &PgPool, org: OrgId, inserted: usize) {
    if inserted < REFRESH_MIN_ROWS {
        return;
    }
    let refreshed = with_org_conn::<_, _, HrError>(pool, org, |tx| {
        Box::pin(async move {
            sqlx::query("SELECT hr_refresh_import_statistics()")
                .execute(tx.as_mut())
                .await?;
            Ok(())
        })
    })
    .await;
    if let Err(error) = refreshed {
        tracing::warn!(
            code = error.code,
            inserted,
            "planner statistics refresh after an import apply failed"
        );
    }
}
