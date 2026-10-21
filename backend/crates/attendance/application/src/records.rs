//! 근태 기록 (ATT S2) commands. Read models are in `records_read`.

pub mod thresholds;

use serde::{Deserialize, Serialize};
use time::Date;
use uuid::Uuid;

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

fn unconfirmed(value: &bool) -> bool {
    !*value
}

/// One typed cell: a person, a day, a value in the entry grammar, and the
/// entry the typist saw (If-Match; `None` = the day was empty).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CellInput {
    pub employee_id: Uuid,
    #[serde(with = "iso_date")]
    pub work_date: Date,
    pub value: String,
    /// Explicit acknowledgement of this value; defaults to refusal for older clients.
    #[serde(default, skip_serializing_if = "unconfirmed")]
    pub long_span_confirmed: bool,
    #[serde(default)]
    pub base_entry_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceKind {
    PaperSheet,
    SupervisorConfirm,
    DeviceFile,
    EmployeeStatement,
    Other,
}

impl EvidenceKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PaperSheet => "PAPER_SHEET",
            Self::SupervisorConfirm => "SUPERVISOR_CONFIRM",
            Self::DeviceFile => "DEVICE_FILE",
            Self::EmployeeStatement => "EMPLOYEE_STATEMENT",
            Self::Other => "OTHER",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EntrySource {
    Manual,
    Bulk,
    Paste,
    Schedule,
}

impl EntrySource {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "MANUAL",
            Self::Bulk => "BULK",
            Self::Paste => "PASTE",
            Self::Schedule => "SCHEDULE",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Evidence {
    pub kind: EvidenceKind,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub confirmer_employee_id: Option<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewInput {
    pub cells: Vec<CellInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SaveInput {
    pub cells: Vec<CellInput>,
    pub source: EntrySource,
    pub evidence: Evidence,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CorrectInput {
    pub value: String,
    /// Explicit acknowledgement of this value; defaults to refusal for older clients.
    #[serde(default, skip_serializing_if = "unconfirmed")]
    pub long_span_confirmed: bool,
    pub reason: String,
    pub evidence: Evidence,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoidInput {
    pub reason: String,
    pub evidence: Evidence,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoInput {
    pub reason: String,
}

/// The most cells one save writes in one transaction (spec §1.4).
pub const MAX_CELLS: usize = 10_000;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn older_clients_default_to_unconfirmed_and_keep_their_idempotency_fingerprint_shape() {
        let old = json!({"employee_id": Uuid::nil(), "work_date": "2026-10-06", "value": "5-23", "base_entry_id": null});
        let mut cell: CellInput = serde_json::from_value(old.clone()).unwrap();
        assert!(!cell.long_span_confirmed);
        assert_eq!(serde_json::to_value(&cell).unwrap(), old);
        cell.long_span_confirmed = true;
        assert_eq!(
            serde_json::to_value(&cell).unwrap()["long_span_confirmed"],
            true
        );
    }
}
