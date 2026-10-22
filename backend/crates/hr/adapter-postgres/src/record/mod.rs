//! 인사카드 이력 sections (MR-31): 학력, 자격·면허, 병역, 교육 이수 as child
//! records of the natural person (`persons`, 0213), keyed through
//! `employee_person_bindings`. Create, correct (UPDATE) and void append
//! revisions to `person_record_revisions` (0261); history is the revision
//! list. Each section has a tenant switch (`hr.record.<section>.enabled`):
//! off refuses every create, update and import row; reads and voids stay
//! open so collected data can still be seen and voided.
//!
//! Access: org-wide `employee_directory_manage` for reads and writes, as the
//! other 인사카드 surfaces (EMP-MODEL contracts). Audit rows carry the
//! section, entry and version, never the values.

mod commands;
mod import;
mod import_plan;
mod person;
mod read;
mod restricted;
mod restricted_read;
mod store;
mod store_cols;
mod store_fields;
mod store_write;
mod support;
mod switch;

pub use import::{ImportReport, ImportRow, ImportRowResult, ImportSheetRequest};
pub use read::{SectionSheet, SectionSheetRow};
pub use restricted::RecordPurpose;

use console_hr_domain::record::{RecordFields, RecordSource, RevisionKind, Section};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::HrError;

/// `POST /employees/{id}/records/{section}`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRecordRequest {
    pub fields: serde_json::Value,
}

/// `PUT /employees/{id}/records/{section}/{entry_id}`: a correction. The
/// whole new snapshot, bound to the version the editor saw.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRecordRequest {
    pub expected_version: i64,
    pub fields: serde_json::Value,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `POST /employees/{id}/records/{section}/{entry_id}/void`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VoidRecordRequest {
    pub expected_version: i64,
    pub reason: String,
}

/// One entry as it stands now.
#[derive(Debug, Clone, Serialize)]
pub struct RecordEntryView {
    pub id: Uuid,
    pub section: Section,
    pub version: i64,
    pub voided: bool,
    pub source: RecordSource,
    pub fields: RecordFields,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// When the latest revision was written.
    #[serde(with = "time::serde::rfc3339")]
    pub revised_at: OffsetDateTime,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct SectionState {
    pub section: Section,
    /// The tenant switch in force now. Off: no create, update or import.
    pub enabled: bool,
}

/// `GET /employees/{id}/records`.
#[derive(Debug, Clone, Serialize)]
pub struct RecordList {
    pub sections: Vec<SectionState>,
    pub items: Vec<RecordEntryView>,
}

/// One revision of an entry, oldest first in [`RecordHistory`].
#[derive(Debug, Clone, Serialize)]
pub struct RecordRevisionView {
    pub actor_kind: Option<String>,
    pub command_id: Option<Uuid>,
    pub version: i64,
    pub kind: RevisionKind,
    pub source: RecordSource,
    pub reason: Option<String>,
    pub actor_id: Uuid,
    pub fields: RecordFields,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordHistory {
    pub entry_id: Uuid,
    pub section: Section,
    pub revisions: Vec<RecordRevisionView>,
}

/// Parse a request's `fields` for `section` and run the domain rules.
///
/// # Errors
/// 422 when the shape is wrong for the section or a rule fails.
pub fn parse_fields(section: Section, raw: serde_json::Value) -> Result<RecordFields, HrError> {
    use console_hr_domain::record::RecordFields as F;
    // Fixed text: serde's message echoes the offending value, and this one
    // can land in a stored import report, which holds no cell values.
    let shape = |_: serde_json::Error| {
        HrError::validation(format!(
            "fields do not match the {} section",
            section.segment()
        ))
    };
    let fields = match section {
        Section::Education => F::Education(serde_json::from_value(raw).map_err(shape)?),
        Section::Qualification => F::Qualification(serde_json::from_value(raw).map_err(shape)?),
        Section::Military => F::Military(serde_json::from_value(raw).map_err(shape)?),
        Section::Training => F::Training(serde_json::from_value(raw).map_err(shape)?),
        Section::Language => F::Language(serde_json::from_value(raw).map_err(shape)?),
        Section::Award => F::Award(serde_json::from_value(raw).map_err(shape)?),
        Section::Discipline => F::Discipline(serde_json::from_value(raw).map_err(shape)?),
        Section::Family => F::Family(serde_json::from_value(raw).map_err(shape)?),
        Section::Disability => F::Disability(serde_json::from_value(raw).map_err(shape)?),
        Section::Veteran => F::Veteran(serde_json::from_value(raw).map_err(shape)?),
    };
    Ok(fields.validate()?)
}

/// 409 `record_version_conflict`: the entry moved on since the editor read it.
pub(crate) fn version_conflict(current: i64) -> HrError {
    HrError {
        errors: None,
        status: http::StatusCode::CONFLICT,
        code: "record_version_conflict",
        message: format!("the entry is at version {current}; reload it and apply the change again"),
        refusals: None,
    }
}
