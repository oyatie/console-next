//! Parsed employee workbook rows, canonical fields and row status.
//! Moved from `app/src/hr.rs` (R2-import).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use console_hr_domain::import::review::Note;

use crate::HrError;
use crate::import::sheet::StagedIdentity;
use crate::import::types::EmployeeImportColumn;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmployeeCanonicalFields {
    /// Absent in N-1 stored runs whose worksite column also carried statutory placement.
    #[serde(default)]
    pub place_targets_split: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company_brn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub employee_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workplace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worksite_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worksite_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hire_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_date: Option<String>,
    /// BW-10: date of birth cell text (typed by the dry run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birth_date: Option<String>,
    /// MR-7: employment type cell text (mapped by the dry run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub employment_type: Option<String>,
    #[serde(default = "default_active_status")]
    pub employment_status: String,
    /// r3:hire-16: `MALE` / `FEMALE` (the sex column, else the resident
    /// registration number's 7th digit); contract end date and probation end
    /// date cell text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_end_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probation_end_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave_accrued: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave_used: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave_remaining: Option<String>,
    /// Days and hours worked in the run's pay period, as decimals: what a
    /// column was mapped to. The payroll roster reads these, never a header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_days: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regular_hours: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overtime_hours: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub night_hours: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holiday_hours: Option<String>,
    /// IMPORT-2: employment status, leave start date, leave type cell text (typed by the dry run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave_start_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave_return_date: Option<String>,
}

impl EmployeeCanonicalFields {
    /// Decode old staged runs once at the boundary; fresh physical sites never bind a workplace.
    pub fn workplace_text(&self) -> Option<&String> {
        self.workplace.as_ref().or_else(|| {
            (!self.place_targets_split)
                .then_some(self.worksite_name.as_ref())
                .flatten()
        })
    }
}

pub fn default_active_status() -> String {
    "ACTIVE".to_owned()
}

#[derive(Debug, Clone, Default)]
pub struct ParsedEmployeeImportWorkbook {
    pub rows: Vec<ParsedEmployeeImportRow>,
    pub columns: Vec<EmployeeImportColumn>,
    /// IMPORT-2: per-sheet reports as stored with the run (no header candidates).
    pub sheets: Vec<Value>,
    /// IMPORT-2: sealed resident registration numbers of rows, staged apart from the raw rows.
    pub identities: Vec<StagedIdentity>,
    /// W12: `(source_key, E.164)` of rows with a mobile phone, staged apart too.
    pub phones: Vec<(String, String)>,
    /// IMPORT-2: sheet- and cell-level needs-review items of the parse.
    pub notes: Vec<Note>,
    /// IMPORT-2: header labels the operator mapped (memory key → target).
    pub remembered: Vec<(String, Option<String>)>,
    /// IMPORT-2: the sheet reports the response shows (header candidates of
    /// an unmapped sheet included; never stored).
    pub shown: Vec<Value>,
}

impl ParsedEmployeeImportWorkbook {
    pub fn input_rows(&self) -> usize {
        self.rows.len()
    }

    pub fn candidate_rows(&self) -> usize {
        self.rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Candidate)
            .count()
    }

    pub fn preserved_rows(&self) -> usize {
        self.rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Preserved)
            .count()
    }
}

#[derive(Debug, Clone)]
pub struct ParsedEmployeeImportRow {
    pub company: String,
    pub name: Option<String>,
    pub source_filename: String,
    pub source_sheet: String,
    pub source_row: i32,
    pub source_key: String,
    pub raw_row: Value,
    pub source_metadata: Value,
    pub canonical: Option<EmployeeCanonicalFields>,
    pub row_status: ImportRowStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportRowStatus {
    Candidate,
    Preserved,
    Error,
}

impl ImportRowStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "CANDIDATE",
            Self::Preserved => "PRESERVED",
            Self::Error => "ERROR",
        }
    }

    pub fn from_db(value: &str) -> Result<Self, HrError> {
        match value {
            "CANDIDATE" => Ok(Self::Candidate),
            "PRESERVED" => Ok(Self::Preserved),
            "ERROR" => Ok(Self::Error),
            _ => Err(HrError::validation("stored import row has invalid status")),
        }
    }
}
