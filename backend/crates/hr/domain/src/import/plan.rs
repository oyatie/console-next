//! BW-10 the import plan: what one candidate row of a run will do, decided
//! from the row, the people on file and the operator's decisions. Identity is
//! the employee number (or an alias), then the resident registration number
//! keyed hash (decisions #25); a row matching neither waits for the operator
//! when it resembles people on file. Pure: the adapter loads the facts and
//! stores the plan.

use std::collections::BTreeMap;

use serde::Serialize;
#[path = "plan_input.rs"]
mod input;
pub use input::{Decisions, Exclusion, IdentityPick, ImportRow};
use time::Date;
use uuid::Uuid;

use super::numbering::Numbering;

/// The legal entity text of a person whose legal entity nobody decided yet
/// (r3:hire-01): an import never guesses one, and the unplaced queue shows them
/// as "legal entity undetermined".
pub const ENTITY_UNDECIDED: &str = "법인 미정";

/// A person on file, as the plan compares them (merged-away rows excluded).
#[derive(Debug, Clone, Default)]
pub struct OnFile {
    pub id: Uuid,
    pub employee_number: Option<String>,
    pub name: String,
    pub status: String,
    pub company: String,
    pub workplace_id: Option<Uuid>,
    pub birth_date: Option<Date>,
    /// The first day of every employment period (registration, ONBOARD, REHIRE).
    pub period_starts: Vec<Date>,
    pub exit_date: Option<Date>,
    pub org_unit: Option<String>,
    pub job: Option<String>,
    pub position: Option<String>,
    pub worksite_name: Option<String>,
    pub worksite_address: Option<String>,
    /// The employment profile's employment type; `None`: no profile yet.
    pub employment_type: Option<String>,
    /// The head's `updated_at` (RFC 3339): apply refuses if it moved.
    pub observed: String,
    /// IMPORT-2: the keyed hash of the stored resident registration number, if any.
    pub rrn_hmac: Option<Vec<u8>>,
    /// IMPORT-2: earlier employee numbers that still find this person.
    pub aliases: Vec<String>,
}

/// The group answers a run takes (`Decisions::group_answers`).
pub const GROUP_ANSWERS: [(&str, &[&str]); 2] = [
    ("workplace_conflict", &["follow_unit", "follow_workplace"]),
    ("status_conflict", &["pre_hire"]),
];

/// One field the row changes (`from` is the value on file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldChange {
    pub field: &'static str,
    pub from: Option<String>,
    pub to: String,
}

/// A difference import never writes for an existing person, with where it
/// is done instead: `lifecycle_transfer` (personnel order), `exit_case` (exit
/// processing), `rehire` (rehire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Deferred {
    pub field: &'static str,
    pub from: Option<String>,
    pub to: Option<String>,
    pub route: &'static str,
}

/// A person a row without an employee number may be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Candidate {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub status: String,
    /// `rrn`, `name_birth_date` or `name_only`.
    pub basis: &'static str,
    /// IMPORT-2 (namesakes): what tells namesakes apart, never a name suffix.
    pub company: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit: Option<String>,
    /// `1990-01-**`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub birth_date_masked: Option<String>,
}

/// IMPORT-2 (decisions #26): a leave of absence the file records for a new
/// person, applied as a setup fact from its start date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetupLeave {
    pub start_date: String,
    pub leave_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_return_date: Option<String>,
}

/// The values a new person is created with (dates `YYYY-MM-DD`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewPerson {
    /// `None`: the next tenant number is assigned at apply.
    pub employee_number: Option<String>,
    pub status: &'static str,
    pub hire_date: String,
    pub exit_date: Option<String>,
    pub birth_date: Option<String>,
    pub org_unit: Option<String>,
    pub org_unit_id: Option<Uuid>,
    /// First load of a former employee (Labor Standards Act §42 retention): the
    /// migration mark.
    pub migrated_former: bool,
    /// MR-7: the workplace the person is placed at from the hire date (its legal
    /// entity follows); `None`: unplaced.
    pub workplace_id: Option<Uuid>,
    /// MR-7: the employment profile's employment type; `None`: no profile yet.
    pub employment_type: Option<String>,
    /// A unit name that resolved to no unit: kept as the person's source
    /// value ("unplaced · source department").
    pub unresolved_org_unit: Option<String>,
    /// IMPORT-2: where the employee number came from (`file`, `rule`, `manual`);
    /// `None` with no number: "no employee number assigned".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub employee_number_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leave: Option<SetupLeave>,
    /// W03: why a current person comes in unplaced: `unit_unknown`,
    /// `unit_ambiguous`, `unit_left_unplaced` (the operator's `null`),
    /// `workplace_unknown` (a bound unit under no open workplace), `no_place` (no
    /// department and no workplace text that binds); `None`: placed, or a former
    /// employee.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unplaced_reason: Option<&'static str>,
    /// r3:hire-16: the worker register facts a new person's first records take:
    /// sex, and the employment profile's contract end date and probation end date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_end_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probation_end_date: Option<String>,
}

/// The per-row result of the dry run. `outcome` is one of `insert`, `update`,
/// `unchanged`, `excluded`, `refused`, `unresolved_identity`; apply runs only
/// when every row is one of the first four. An unknown unit is no longer a
/// question that blocks apply: the person comes in unplaced (MR-7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedRow {
    pub source_key: String,
    pub sheet: String,
    pub row: i32,
    pub name: String,
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub employee_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub employee_number: Option<String>,
    /// `update`: the head `updated_at` the plan saw.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diff: Vec<FieldChange>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deferred: Vec<Deferred>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_person: Option<NewPerson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal_code: Option<&'static str>,
    /// `refused`: which cell (e.g. `hire_date` for `invalid_date`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal_field: Option<&'static str>,
    /// The file's unit name that bound no unit (the person is unplaced).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_name: Option<String>,
    /// The file's workplace text that named no workplace (MR-7).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workplace_name: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<Candidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclusion_code: Option<String>,
    /// IMPORT-2: how the person on file was found (`employee_number`,
    /// `alias`, `rrn`, `pick`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_by: Option<&'static str>,
}

impl PlannedRow {
    /// Whether apply may proceed past this row.
    #[must_use]
    pub fn is_settled(&self) -> bool {
        matches!(self.outcome, "insert" | "update" | "unchanged" | "excluded")
    }
}

/// The tenant-level facts every row is planned against.
#[derive(Debug, Clone)]
pub struct PlanFacts<'a> {
    pub company_workplaces: &'a BTreeMap<String, Vec<Uuid>>,
    pub people: &'a [OnFile],
    /// Unit name → ids of the ACTIVE units with that name.
    pub units: &'a BTreeMap<String, Vec<Uuid>>,
    /// Unit id → the open workplace it sits in (itself or an ancestor).
    pub unit_workplaces: &'a BTreeMap<Uuid, Uuid>,
    /// Workplace name → ids of the open workplaces with that name.
    pub workplaces: &'a BTreeMap<String, Vec<Uuid>>,
    pub today: Date,
    /// No payroll period is approved yet, so former employees may still be
    /// loaded as EXITED (W-05).
    pub former_load_open: bool,
    /// IMPORT-2: the numbering rules and the numbers in use.
    pub numbering: &'a Numbering,
}
