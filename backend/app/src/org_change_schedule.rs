//! Scheduled org changes (UX-R2 ORGCHANGE org-02): an APPROVED change applies
//! on its 시행일 with nobody pressing 시행 — from 00:05 KST that day, on the
//! lifecycle schedule's tick (registered there, one line), so it runs in both
//! roles and follows that loop's debug-only date override in E2E. The store
//! owns the locked, audited, idempotent apply (`effectuate_due`); its audit
//! rows are what the event stream publishes (decisions #27). No new loop.

use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime, Time, macros::offset};

use crate::wiring::orgchange_ports::{PgEmploymentTransferPort, PgOrgUnitWritePort};
use console_orgchange_adapter_postgres::PgOrgChangeStore;

/// The 시행일 a change must be on or before to apply now: `today` once it is
/// 00:05 KST, else the day before. A `today` ahead of the wall clock (the
/// debug override) is taken as is.
fn due_through(today: Date, now: OffsetDateTime) -> Date {
    let kst = now.to_offset(offset!(+9));
    if today > kst.date() || kst.time() >= Time::from_hms(0, 5, 0).unwrap_or(Time::MIDNIGHT) {
        today
    } else {
        today - Duration::days(1)
    }
}

/// Applies the org changes due on `today` (KST); a failure is logged and
/// retried on the next tick.
pub async fn apply_due_org_changes(pool: &PgPool, today: Date) -> Result<usize, String> {
    PgOrgChangeStore::new(pool.clone())
        .with_employment_transfer(std::sync::Arc::new(PgEmploymentTransferPort))
        .with_org_unit_write(std::sync::Arc::new(PgOrgUnitWritePort))
        .effectuate_due(due_through(today, OffsetDateTime::now_utc()))
        .await
}

/// The tick's one registration: run and log.
pub(crate) async fn tick(pool: &PgPool, today: Date) {
    match apply_due_org_changes(pool, today).await {
        Ok(0) => {}
        Ok(applied) => tracing::info!(applied, "scheduled org changes applied"),
        Err(error) => tracing::warn!(%error, "scheduled org change run failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::due_through;
    use time::macros::{date, datetime};

    #[test]
    fn a_change_is_due_from_five_past_midnight_kst() {
        let today = date!(2026 - 10 - 08);
        // 00:04 KST = 15:04 UTC the day before.
        assert_eq!(
            due_through(today, datetime!(2026-10-07 15:04 UTC)),
            date!(2026 - 10 - 07)
        );
        assert_eq!(due_through(today, datetime!(2026-10-07 15:05 UTC)), today);
        // The debug override runs ahead of the clock: its date is due.
        assert_eq!(
            due_through(date!(2026 - 10 - 20), datetime!(2026-10-07 15:00 UTC)),
            date!(2026 - 10 - 20)
        );
    }
}
