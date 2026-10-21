//! Employee import request, report, preview and stored-row types.
//! Moved from `app/src/hr.rs` (R2-import).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use time::Date;
use uuid::Uuid;

use console_hr_domain::import::fields::EMPLOYEE_IMPORT_FIELD_DEFINITIONS;
use console_hr_domain::import::plan::{Decisions, PlannedRow};
use console_hr_domain::import::review::ReviewQueue;
use console_hr_domain::import::summary::{AutoMapped, Unplaced};

use crate::import::mask::{employee_import_mapping_profile, masked_preview_values};
use crate::import::parsed::{EmployeeCanonicalFields, ImportRowStatus, ParsedEmployeeImportRow};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmployeeImportReport {
    pub input_rows: usize,
    pub inserted: usize,
    pub updated: usize,
    pub skipped: usize,
    pub companies: Vec<CompanyImportSummary>,
    /// Rows bound to a canonical OrgUnit because their org_unit text names
    /// exactly one ACTIVE unit. Units are never created by an import.
    #[serde(default)]
    pub org_units_bound: usize,
    /// W03: the new people the run brought in 미배치, by reason (the dry
    /// run's count); absent on runs applied before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unplaced: Option<Unplaced>,
    /// r3:hire-16 / records-02: the 근로자 명부 (근기법 시행령 §20) items the
    /// run's new people still lack, said at the end of the import; absent on
    /// runs applied before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub register_gaps: Option<RegisterGaps>,
}

/// New people of the run missing each 명부 item (the 퇴직 사유: former
/// employees only).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisterGaps {
    pub people: usize,
    pub sex: usize,
    pub address: usize,
    pub careers: usize,
    pub exit_reason: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompanyImportSummary {
    pub company: String,
    pub input_rows: usize,
    pub inserted: usize,
    pub updated: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct EmployeeImportColumn {
    pub source_header: String,
    pub normalized_header: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub classification: String,
    pub preview_allowed: bool,
    /// G9: a note the preview shows beside the column
    /// (`customer_site_not_workplace` for a 사업장 column).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct EmployeeImportPreviewRow {
    pub source_sheet: String,
    pub source_row: i32,
    pub row_status: String,
    pub values: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct EmployeeImportPreviewResponse {
    pub run_id: Uuid,
    pub entity_type: String,
    pub source_filename: String,
    pub source_sha256: String,
    pub input_rows: usize,
    pub candidate_rows: usize,
    pub preserved_rows: usize,
    pub columns: Vec<EmployeeImportColumn>,
    pub sample_rows: Vec<EmployeeImportPreviewRow>,
    pub mapping_profile: Value,
    /// IMPORT-2: every sheet — `mapped` (header row, column → target, where
    /// each came from), `needs_mapping` (likeliest header rows), `empty`,
    /// `skipped`.
    pub sheets: Vec<Value>,
    /// IMPORT-2: sheets that need the operator's mapping (blocking items).
    pub sheets_needing_mapping: usize,
    /// IMPORT-2: the targets a column may be mapped to.
    pub available_targets: Vec<&'static str>,
    /// IMPORT-2: rows whose 주민등록번호 was sealed for matching.
    pub sealed_identities: usize,
}

impl EmployeeImportPreviewResponse {
    pub fn from_rows(
        run_id: Uuid,
        source_filename: String,
        source_sha256: String,
        columns: Vec<EmployeeImportColumn>,
        rows: Vec<ParsedEmployeeImportRow>,
    ) -> Self {
        let sample_rows = rows
            .iter()
            .take(12)
            .map(|row| EmployeeImportPreviewRow {
                source_sheet: row.source_sheet.clone(),
                source_row: row.source_row,
                row_status: row.row_status.as_str().to_owned(),
                values: masked_preview_values(&row.raw_row, &columns),
            })
            .collect::<Vec<_>>();
        let input_rows = rows.len();
        let candidate_rows = rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Candidate)
            .count();
        let preserved_rows = rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Preserved)
            .count();
        let mapping_profile = employee_import_mapping_profile(&columns);

        Self {
            sheets: Vec::new(),
            sheets_needing_mapping: 0,
            available_targets: EMPLOYEE_IMPORT_FIELD_DEFINITIONS
                .iter()
                .map(|field| field.target)
                .collect(),
            sealed_identities: 0,
            run_id,
            entity_type: "employee_hr".to_owned(),
            source_filename,
            source_sha256,
            input_rows,
            candidate_rows,
            preserved_rows,
            columns,
            sample_rows,
            mapping_profile,
        }
    }
}

/// The dry run (BW-10): one planned row per candidate row, the counts, and
/// the digest the apply must name.
#[derive(Debug, Serialize)]
pub struct EmployeeImportDryRunSummary {
    pub run_id: Uuid,
    pub input_rows: usize,
    pub candidate_rows: usize,
    pub preserved_rows: usize,
    pub insert_candidates: usize,
    pub update_candidates: usize,
    pub unchanged_rows: usize,
    pub excluded_rows: usize,
    /// Rows apply refuses to pass: `refused`, `unresolved_unit`,
    /// `unresolved_identity`. Apply runs only at zero.
    pub unsettled_rows: usize,
    pub companies: Vec<CompanyImportSummary>,
    /// New people bound to a unit by name or by the unit map.
    pub org_unit_bound_rows: usize,
    pub org_unit_unbound_rows: usize,
    /// Unit names that resolved to no single ACTIVE unit and are not mapped.
    pub unresolved_org_units: Vec<String>,
    /// sha-256 of `rows`; `POST …/apply` names it.
    pub dry_run_digest: String,
    pub decisions: Decisions,
    pub rows: Vec<PlannedRow>,
    /// IMPORT-2: the 「확인 필요」 queue (counted; `blocking` keeps apply closed).
    pub review: ReviewQueue,
    /// IMPORT-2: `(decision, key)` entries filled from the tenant's memory.
    pub remembered: Vec<RememberedEntry>,
    /// W02: 고용형태 labels the catalog mapped (overridable).
    pub auto_mapped: Vec<AutoMapped>,
    /// W02: new people who come in with no 고용형태 (the apply button names it).
    pub employment_type_empty_rows: usize,
    /// W03: new people who come in 미배치, by reason (the apply button names it).
    pub unplaced: Unplaced,
    /// W12: rows whose 휴대전화 is not stored (a new person with no 고용형태; a
    /// person on file, whose phone is changed on the 인사카드).
    pub phone_unstored_rows: usize,
}

/// A decision entry the dry run took from the tenant's mapping memory.
#[derive(Debug, Clone, Serialize)]
pub struct RememberedEntry {
    pub decision: &'static str,
    pub key: String,
}

/// `POST …/dry-run`: the operator's decisions (all optional). Each call
/// re-plans the run and replaces the stored decisions.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportDryRunRequest {
    #[serde(default)]
    pub decisions: Decisions,
}

#[derive(Debug)]
pub struct DataImportRunRecord {
    pub entity_type: String,
    pub status: String,
    pub source_sha256: String,
    pub input_rows: i32,
    pub candidate_rows: i32,
    pub preserved_rows: i32,
}

#[derive(Debug)]
pub struct StoredEmployeeImportRow {
    pub company: String,
    pub name: String,
    pub source_filename: String,
    pub source_sheet: String,
    pub source_row: i32,
    pub source_key: String,
    pub raw_row: Value,
    pub source_metadata: Value,
    pub canonical: EmployeeCanonicalFields,
}

/// Optional body for the attendance ingest-commit ("적재") apply call.
/// `checklist_all_acknowledged` is the §16 self-checklist evidence the gate
/// chain requires (85 판정). The employee apply binds a digest instead.
#[derive(Debug, Default, Deserialize)]
pub struct ImportApplyRequest {
    #[serde(default)]
    pub checklist_all_acknowledged: Option<bool>,
}

/// `POST /api/v1/employees/import/{run_id}/apply`: binds the apply to the
/// dry run the operator saw (BW-10 7).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmployeeImportApplyRequest {
    pub dry_run_digest: String,
}

pub struct XlsxUpload {
    pub filename: String,
    pub bytes: Vec<u8>,
    /// IMPORT-2: the operator's `mapping` field (JSON), if sent.
    pub mapping: Option<String>,
    /// The pay period this upload covers, declared by the uploader: both or
    /// neither, never defaulted. Required for attendance (and NOT NULL there,
    /// 0300); an employee roster may declare none (W12), and is then never
    /// payroll material.
    pub pay_period_start: Option<Date>,
    pub pay_period_end: Option<Date>,
}
