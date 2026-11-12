//! Workbook source values and explicit review decisions.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// One candidate row as the workbook gave it (cells trimmed, empty = None).
#[derive(Debug, Clone, Default)]
pub struct ImportRow {
    pub source_key: String,
    pub sheet: String,
    pub row: i32,
    pub name: String,
    pub company: String,
    pub company_brn: Option<String>,
    pub employee_number: Option<String>,
    pub hire_date: Option<String>,
    pub exit_date: Option<String>,
    pub birth_date: Option<String>,
    pub org_unit: Option<String>,
    pub job: Option<String>,
    pub position: Option<String>,
    pub workplace: Option<String>,
    pub worksite_name: Option<String>,
    pub worksite_address: Option<String>,
    /// Employment type as the file wrote it (a code or a label the operator maps).
    pub employment_type: Option<String>,
    /// IMPORT-2: employment status, leave start date and leave type as the file wrote them.
    pub status: Option<String>,
    pub leave_start_date: Option<String>,
    pub leave_type: Option<String>,
    /// Expected return date (required for childcare leave and maternity leave).
    pub leave_return_date: Option<String>,
    /// IMPORT-2: the keyed hash of the row's resident registration number (never
    /// the number).
    pub rrn_hmac: Option<Vec<u8>>,
    /// W12: the row has a mobile phone (the number stays in the stored row).
    pub has_phone: bool,
    /// r3:hire-16: `MALE` / `FEMALE` from the sex column or the resident
    /// registration number.
    pub sex: Option<String>,
    /// r3:hire-16: contract end date and probation end date as the file wrote them.
    pub contract_end_date: Option<String>,
    pub probation_end_date: Option<String>,
}

/// The operator's choice for a row without an employee number that resembles
/// people on file: one of them (`employee_id`), or a new person (`null`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityPick {
    pub employee_id: Option<Uuid>,
}

/// A row left out of the import (BW-07 domain `import_exclude`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exclusion {
    pub reason_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What the operator decided on the dry run; stored with the run, so the
/// apply re-plans with exactly these.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decisions {
    /// Imported company alias → a certificate-confirmed entity's primary workplace, or unresolved.
    #[serde(default)]
    pub company_map: BTreeMap<String, Option<Uuid>>,
    /// Unit name in the file → an ACTIVE unit id, or `null`: unplaced (no
    /// unit). An unknown name the operator did not answer is unplaced too.
    #[serde(default)]
    pub unit_map: BTreeMap<String, Option<Uuid>>,
    /// Workplace text in the file → an open workplace id, or `null`: not a
    /// workplace (a site name), so it places nobody.
    #[serde(default)]
    pub workplace_map: BTreeMap<String, Option<Uuid>>,
    /// Employment type text in the file → an employment type code, or `null`:
    /// leave it empty ("information not entered"). The codes themselves map
    /// without an answer.
    #[serde(default)]
    pub employment_type_map: BTreeMap<String, Option<String>>,
    /// `source_key` → the person a row without an employee number is.
    #[serde(default)]
    pub identity: BTreeMap<String, IdentityPick>,
    /// `source_key` → why the row is left out.
    #[serde(default)]
    pub exclusions: BTreeMap<String, Exclusion>,
    /// IMPORT-2: employment status text → status code (`ACTIVE`, `ON_LEAVE`, ...).
    #[serde(default)]
    pub status_map: BTreeMap<String, String>,
    /// IMPORT-2: leave type text (`""` when the cell is empty) → leave type.
    #[serde(default)]
    pub leave_type_map: BTreeMap<String, String>,
    /// IMPORT-2: `source_key` → the employee number the operator gives a row
    /// without one.
    #[serde(default)]
    pub employee_numbers: BTreeMap<String, String>,
    /// W05: `reason` or `reason:field` → why every such row is left out
    /// (`plan_group`). A row's own `exclusions` entry wins.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub group_exclusions: BTreeMap<String, Exclusion>,
    /// r3:hire-19: one answer for a conflict pattern, never row by row —
    /// `workplace_conflict` → `follow_unit` (the department's workplace) or
    /// `follow_workplace` (the work location, the department left unplaced);
    /// `status_conflict` → `pre_hire` (employed with a future hire date comes
    /// in as pending hire).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub group_answers: BTreeMap<String, String>,
}
