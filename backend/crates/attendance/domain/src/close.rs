//! Whether a 근태 month takes writes. A month close reaching a branch (an
//! org-wide close reaches every branch) closes the month there; an approved
//! payroll period unlock covering the whole month reopens it until the window
//! re-locks. Period locks are org-wide (BW-15), so a reopen reaches every close
//! of that month.

use serde::Serialize;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

/// One `attendance_month_closes` row: `month` is the first day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonthClose {
    pub month: Date,
    pub branch: Option<Uuid>,
}

/// The newest payroll lock row of one window (`period_lock_effective()` read
/// by the adapter: in force, or not).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockWindow {
    pub lock_id: Uuid,
    pub start: Date,
    pub end: Date,
    pub in_force: bool,
    pub relock_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MonthState {
    Open,
    /// `lock_id` is the lock to request an unlock of; `None` when no payroll
    /// lock covers the month (a branch close alone).
    Closed {
        lock_id: Option<Uuid>,
    },
    /// `relock_at` is `None` only for an unlock that predates time boxes.
    Reopened {
        lock_id: Uuid,
        #[serde(with = "time::serde::rfc3339::option")]
        relock_at: Option<OffsetDateTime>,
    },
}

impl MonthState {
    #[must_use]
    pub const fn takes_writes(&self) -> bool {
        !matches!(self, Self::Closed { .. })
    }

    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed { .. } => "closed",
            Self::Reopened { .. } => "reopened",
        }
    }
}

/// The first day of `date`'s month.
#[must_use]
pub fn month_of(date: Date) -> Date {
    date.replace_day(1).unwrap_or(date)
}

fn last_day(month: Date) -> Date {
    let next = (month + Duration::days(31)).replace_day(1).unwrap_or(month);
    next - Duration::days(1)
}

/// The state of `month` (any day of it) for a person in `branch`.
#[must_use]
pub fn month_state(
    month: Date,
    branch: Option<Uuid>,
    closes: &[MonthClose],
    windows: &[LockWindow],
) -> MonthState {
    let (first, last) = (month_of(month), last_day(month_of(month)));
    if !closes
        .iter()
        .any(|c| c.month == first && (c.branch.is_none() || c.branch == branch))
    {
        return MonthState::Open;
    }
    let overlapping = || windows.iter().filter(|w| w.start <= last && w.end >= first);
    if let Some(w) = overlapping().find(|w| w.in_force) {
        return MonthState::Closed {
            lock_id: Some(w.lock_id),
        };
    }
    overlapping()
        .filter(|w| w.start <= first && w.end >= last)
        .min_by_key(|w| w.relock_at.map_or((1, None), |at| (0, Some(at))))
        .map_or(MonthState::Closed { lock_id: None }, |w| {
            MonthState::Reopened {
                lock_id: w.lock_id,
                relock_at: w.relock_at,
            }
        })
}

/// The strictest state of `month` across `branches` (a person who moved within
/// the month, or a write reaching several branches): closed anywhere is closed.
#[must_use]
pub fn strictest(
    month: Date,
    branches: &[Option<Uuid>],
    closes: &[MonthClose],
    windows: &[LockWindow],
) -> MonthState {
    let none = [None];
    let branches = if branches.is_empty() {
        &none[..]
    } else {
        branches
    };
    branches
        .iter()
        .map(|b| month_state(month, *b, closes, windows))
        .max_by_key(|s| match s {
            MonthState::Open => 0,
            MonthState::Reopened { .. } => 1,
            MonthState::Closed { .. } => 2,
        })
        .unwrap_or(MonthState::Open)
}

#[cfg(test)]
#[path = "close_tests.rs"]
mod tests;
