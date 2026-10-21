//! §3.9.1 변경 동결 창: the period-lock gate every dated employment mutation passes.

use super::error::EmploymentError;
use console_platform_db::{PeriodLockDomain, assert_period_open, lock_period_lock_key};
use sqlx::{Postgres, Transaction};
use time::{Date, OffsetDateTime, macros::offset};
use uuid::Uuid;

/// The freeze domains §3.9.1 names — 급여 마감 and 회계 결산. One list, mirroring
/// the org-change adapter's `FREEZE_DOMAINS`, so an employment change and an org
/// change can never freeze on a different set of windows.
const EMPLOYMENT_FREEZE_DOMAINS: [PeriodLockDomain; 2] =
    [PeriodLockDomain::Payroll, PeriodLockDomain::Accounting];

/// The tenant business date (KST, UTC+9) of an instant, mirroring the org-change
/// adapter's `today_kst` offset. The lock date is derived from this fixed offset,
/// never from the caller-supplied RFC3339 offset, so the same instant cannot be
/// submitted as two different calendar days and bypass a closed window.
pub(super) fn business_date(instant: OffsetDateTime) -> Date {
    instant.to_offset(offset!(+9)).date()
}

/// §3.9.1 변경 동결 창 — refuse an employment mutation whose effective date falls
/// inside a closed payroll or accounting period. Runs in the caller's already-
/// armed transaction, so the lookup is RLS-scoped to the caller's tenant and the
/// refusal rolls the whole write back.
///
/// Before the read it takes the same per-tenant, per-domain advisory key the
/// period-lock CREATE path takes ([`console_platform_db::lock_period_lock_key`]),
/// so a lock committed concurrently cannot slip between this read and the
/// write's commit: the two order strictly and the writer either sees the
/// committed lock (refused) or commits before the lock exists (a draft that
/// predates the freeze).
pub(super) async fn assert_employment_change_window_open(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    effective_date: Date,
) -> Result<(), EmploymentError> {
    for domain in EMPLOYMENT_FREEZE_DOMAINS {
        lock_period_lock_key(tx, domain, org_id).await?;
        assert_period_open(tx, domain, effective_date)
            .await
            .map_err(EmploymentError::Frozen)?;
    }
    Ok(())
}
