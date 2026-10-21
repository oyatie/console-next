// SPDX-License-Identifier: LicenseRef-Proprietary
//! Pure inverse import plan and rollback admission.

use serde::Serialize;
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Basis {
    Direct,
    StepUp,
    SecondPerson,
}

/// A routed request is timed at filing, including when it is decided later.
pub fn basis(
    setup: bool,
    applied_at: OffsetDateTime,
    filed_at: OffsetDateTime,
    window_days: i64,
    routed: bool,
) -> Result<Basis, &'static str> {
    if setup {
        Ok(Basis::Direct)
    } else if filed_at >= applied_at + Duration::days(window_days) {
        Err("import_rollback_window_closed")
    } else if routed {
        Ok(Basis::SecondPerson)
    } else {
        Ok(Basis::StepUp)
    }
}

pub fn check_run(status: &str, ledger_complete: bool, pending: bool) -> Result<(), &'static str> {
    match status {
        "ROLLED_BACK" => Err("import_run_already_rolled_back"),
        "APPLIED" if !ledger_complete => Err("import_run_predates_ledger"),
        "APPLIED" if pending => Err("import_rollback_pending"),
        "APPLIED" => Ok(()),
        _ => Err("import_run_not_applied"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockerKind {
    WorkRecord,
    ChangedSince,
    LaterRun,
    AccountLinked,
}

/// Record provenance comes from the effect ledger, never dates or comments.
#[derive(Debug, Default)]
pub struct Dependencies {
    /// `None` is a record that no import run wrote.
    pub work_record_runs: Vec<Option<Uuid>>,
    pub changed_since: bool,
    pub later_run: bool,
    pub account_linked: bool,
}

impl Dependencies {
    #[must_use]
    pub fn kinds(&self, run: Uuid, inserted: bool) -> Vec<BlockerKind> {
        [
            (
                inserted
                    && self
                        .work_record_runs
                        .iter()
                        .any(|source| *source != Some(run)),
                BlockerKind::WorkRecord,
            ),
            (self.changed_since, BlockerKind::ChangedSince),
            (self.later_run, BlockerKind::LaterRun),
            (inserted && self.account_linked, BlockerKind::AccountLinked),
        ]
        .into_iter()
        .filter_map(|(blocked, kind)| blocked.then_some(kind))
        .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct InverseField {
    pub field: String,
    pub current: Option<String>,
    pub before: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct InverseRow {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub inserted: bool,
    pub fields: Vec<InverseField>,
    pub effects: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Blocker {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub kind: BlockerKind,
    pub field: Option<String>,
    pub record: String,
    pub since: String,
}

/// Canonical plan order makes the digest independent of SQL result order.
pub fn preview_digest(
    rows: &[InverseRow],
    blockers: &[Blocker],
) -> Result<String, serde_json::Error> {
    let mut rows = rows.to_vec();
    for row in &mut rows {
        row.fields.sort();
        row.effects.sort();
    }
    rows.sort();
    let mut blockers = blockers.to_vec();
    blockers.sort();
    let bytes = serde_json::to_vec(&(rows, blockers))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(test)]
#[path = "rollback_tests.rs"]
mod tests;
