//! 근무 일정 persistence (ATT S1). Reads run on one RLS-bound snapshot;
//! writes run in one transaction with their audit event (#27 topic
//! `attendance_schedule`).

mod break_floor;
pub(crate) mod codes;
mod crews;
mod holiday_writes;
mod holidays;
mod layers;
pub(crate) mod org;
mod patterns;
pub(crate) mod preview;
pub(crate) mod read;
mod tree;
pub(crate) mod universe;

use std::collections::{BTreeMap, BTreeSet};

use console_attendance_application::CallerScope;
use console_attendance_domain::close::{self, LockWindow, MonthClose, MonthState};
use console_attendance_domain::schedule::ScheduleRefusal;
use console_kernel_core::AuditEvent;
use console_platform_db::{DbError, PeriodLockDomain, lock_period_lock_key};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum ScheduleStoreError {
    #[error("{}", .0.code())]
    Refused(ScheduleRefusal),
    /// 409 with a stable code.
    #[error("{0}")]
    Conflict(&'static str),
    /// 422 with a stable code.
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    NotFound(&'static str),
    #[error("forbidden")]
    Forbidden,
    /// 409 `entry_conflict`: someone saved these person-days after the typist read them.
    #[error("entry_conflict")]
    EntryConflict(Vec<console_attendance_application::records_read::Conflict>),
    /// 422 `cells_refused`: the save is atomic, so one refused cell saves nothing.
    #[error("cells_refused")]
    CellsRefused(Vec<console_attendance_application::records_read::CellPreview>),
    #[error("stored {0} is not readable")]
    Corrupt(&'static str),
    #[error(transparent)]
    Database(#[from] DbError),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
}

impl From<ScheduleRefusal> for ScheduleStoreError {
    fn from(r: ScheduleRefusal) -> Self {
        Self::Refused(r)
    }
}

pub(crate) fn audit(
    caller: &CallerScope,
    action: &str,
    kind: &str,
    id: Uuid,
    after: Value,
) -> Result<AuditEvent, ScheduleStoreError> {
    super::event(caller, action, kind, id, None, Some(after))
        .map_err(|_| ScheduleStoreError::Corrupt("audit"))
}

/// The idempotency key, normalised, after the advisory lock that makes a
/// replay wait for the first writer.
pub(crate) async fn claim_key(
    tx: &mut Transaction<'_, Postgres>,
    caller: &CallerScope,
    key: &str,
) -> Result<String, ScheduleStoreError> {
    let key = console_attendance_application::validate_idempotency_key(key)
        .map_err(|_| ScheduleStoreError::Invalid(codes::IDEMPOTENCY_KEY_INVALID))?;
    super::idempotency_lock(tx, caller.org_id, &key)
        .await
        .map_err(|_| ScheduleStoreError::Corrupt("idempotency lock"))?;
    Ok(key)
}

pub(crate) fn fingerprint(value: &Value) -> String {
    super::fingerprint(value)
}

const MONTH_STATE_DECISIONS_TOTAL: &str = "attendance_month_state_decisions_total";

/// Every 근태 month close and the payroll lock windows that can reopen them;
/// `console_attendance_domain::close` decides from these.
pub(crate) struct Closes {
    closes: Vec<MonthClose>,
    windows: Vec<LockWindow>,
    /// A write's decisions in closed or reopened months, by (month, state,
    /// outcome), reported once per write; `None` for a read or a preview.
    decisions: Option<BTreeMap<(Date, &'static str, &'static str), u64>>,
}

impl Closes {
    pub(crate) async fn load(tx: &mut Transaction<'_, Postgres>) -> Result<Self, sqlx::Error> {
        let closes = sqlx::query_as::<_, (Date, Option<Uuid>)>(
            "SELECT month, branch_id FROM attendance_month_closes",
        )
        .fetch_all(tx.as_mut())
        .await?
        .into_iter()
        .map(|(month, branch)| MonthClose { month, branch })
        .collect();
        // The newest row of each window is the one in force or unlocked.
        let windows = sqlx::query_as::<_, (Uuid, Date, Date, bool, Option<OffsetDateTime>)>(
            "SELECT DISTINCT ON (period_start, period_end) id, period_start, period_end, \
                    period_lock_effective(period_locks), relock_at \
             FROM period_locks WHERE domain = $1 \
             ORDER BY period_start, period_end, locked_at DESC",
        )
        .bind(PeriodLockDomain::Payroll.as_str())
        .fetch_all(tx.as_mut())
        .await?
        .into_iter()
        .map(|(lock_id, start, end, in_force, relock_at)| LockWindow {
            lock_id,
            start,
            end,
            in_force,
            relock_at,
        })
        .collect();
        Ok(Self {
            closes,
            windows,
            decisions: None,
        })
    }

    pub(crate) fn metered(self) -> Self {
        Self {
            decisions: Some(BTreeMap::new()),
            ..self
        }
    }

    /// The state of `date`'s month for people in `branches`.
    pub(crate) fn state(&self, date: Date, branches: &[Option<Uuid>]) -> MonthState {
        close::strictest(date, branches, &self.closes, &self.windows)
    }

    /// Does `date`'s month take a write for a person in `branch`? A write
    /// tallies each decision in a closed or reopened month for [`Self::report`].
    pub(crate) fn open_for(&mut self, date: Date, branch: Option<Uuid>) -> bool {
        let state = self.state(date, &[branch]);
        let open = state.takes_writes();
        if let Some(tally) = self
            .decisions
            .as_mut()
            .filter(|_| state != MonthState::Open)
        {
            let outcome = if open { "taken" } else { "refused" };
            *tally
                .entry((close::month_of(date), state.as_str(), outcome))
                .or_default() += 1;
        }
        open
    }

    /// One log line and one counter step per (month, state, outcome) a write met.
    pub(crate) fn report(&self) {
        for ((month, state, outcome), cells) in self.decisions.iter().flatten() {
            metrics::counter!(MONTH_STATE_DECISIONS_TOTAL, "state" => *state, "outcome" => *outcome)
                .increment(*cells);
            tracing::info!(%month, state, outcome, cells, "attendance closed-month decision");
        }
    }

    /// Closed months (not reopened) that reach these branches.
    pub(crate) fn closed(&self, branches: &[Option<Uuid>]) -> Vec<(i32, u8)> {
        let mut out: Vec<(i32, u8)> = self
            .closes
            .iter()
            .filter(|c| !self.state(c.month, branches).takes_writes())
            .map(|c| (c.month.year(), u8::from(c.month.month())))
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }
}

/// Closed attendance months, not reopened, that reach these branches (an
/// org-wide close reaches every branch).
pub(crate) async fn closed_months(
    tx: &mut Transaction<'_, Postgres>,
    branches: &[Option<Uuid>],
) -> Result<Vec<(i32, u8)>, ScheduleStoreError> {
    Ok(Closes::load(tx).await?.closed(branches))
}

/// Order a write into these dates' months against their close
/// (`close_month_lock`) and, when one is closed, against the payroll unlock and
/// re-lock (`lock_period_lock_key`), so the month state read next holds until
/// commit.
pub(crate) async fn lock_months(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
    dates: impl IntoIterator<Item = Date>,
) -> Result<(), sqlx::Error> {
    let months: BTreeSet<Date> = dates.into_iter().map(close::month_of).collect();
    for month in &months {
        crate::close_month_lock(tx, org_id, *month).await?;
    }
    let months: Vec<Date> = months.into_iter().collect();
    let closed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM attendance_month_closes WHERE month = ANY($1))",
    )
    .bind(&months)
    .fetch_one(tx.as_mut())
    .await?;
    if closed {
        lock_period_lock_key(tx, PeriodLockDomain::Payroll, org_id).await?;
    }
    Ok(())
}

/// A schedule or holiday write, whose months may be open-ended, orders against
/// every payroll unlock and re-lock while any month is closed.
pub(crate) async fn lock_closed_months(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
) -> Result<(), sqlx::Error> {
    let any: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM attendance_month_closes)")
        .fetch_one(tx.as_mut())
        .await?;
    if any {
        lock_period_lock_key(tx, PeriodLockDomain::Payroll, org_id).await?;
    }
    Ok(())
}

pub(crate) fn month_label((y, m): (i32, u8)) -> String {
    format!("{y:04}-{m:02}")
}
