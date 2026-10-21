//! MR-24 / MR-25 pure rules: the five typed catalogs (직급 GRADE, 직위 TITLE,
//! 직책 POSITION, 직무 JOB, 직군 JOB_FAMILY), the dated APPOINT and 고용형태
//! 전환 (EMPLOYMENT_TYPE_CHANGE), and what each leaves on the employee head.
//! 직위 keeps BW-13's `to_job_title_id` / `to_position`; this module adds 직급
//! to PROMOTE and the rest to APPOINT.

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::Date;
use uuid::Uuid;

use super::event::{EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition};
use crate::text::{normalize_enum_text, normalize_optional_limited_text, parse_yyyy_mm_dd};

/// The catalog kinds (`job_titles.kind`).
pub const CATALOG_KINDS: [&str; 5] = ["GRADE", "TITLE", "POSITION", "JOB", "JOB_FAMILY"];

/// The employment types (`employee_employment_profiles.employment_type`, E13).
pub const EMPLOYMENT_TYPES: [&str; 9] = [
    "REGULAR",
    "CONTRACT",
    "PART_TIME",
    "INTERN",
    "DAILY",
    "EXECUTIVE",
    "DISPATCHED_IN",
    "OUTSOURCED_ON_SITE",
    "FREELANCE",
];

/// The request fields of a 직급 PROMOTE, an APPOINT or a 고용형태 전환, also
/// the normalised form (stored in a scheduled request; every field defaults so
/// older scheduled rows decode). Absent = unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassificationChange {
    /// PROMOTE: the 직급 (GRADE) after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_grade_id: Option<Uuid>,
    /// APPOINT: the 직책 (POSITION) after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_position_kind_id: Option<Uuid>,
    /// APPOINT: 보직 해제, the employee holds no 직책 after.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub vacate_position_kind: bool,
    /// APPOINT: the 직무 (JOB) after; its label becomes `to_job`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_job_id: Option<Uuid>,
    /// APPOINT: 종사 업무 as free text (no catalog id), when `to_job_id` is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_job: Option<String>,
    /// APPOINT: the 직군 (JOB_FAMILY) after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_job_family_id: Option<Uuid>,
    /// EMPLOYMENT_TYPE_CHANGE: the 고용형태 after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "deserialize_enum_25")]
    pub to_employment_type: Option<String>,
}

/// The employee's current 직급, 직책, 직무 and 직군 (직위 is
/// `EmployeeForLifecycle::job_title_id`), and the 종사 업무 text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Classification {
    pub grade_id: Option<Uuid>,
    pub position_kind_id: Option<Uuid>,
    pub job_id: Option<Uuid>,
    pub job_family_id: Option<Uuid>,
    pub job: Option<String>,
}

/// The employment type and fixed-term window a 전환 leaves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmploymentWindow {
    pub employment_type: String,
    pub contract_start_date: Option<Date>,
    pub contract_end_date: Option<Date>,
}

fn refuse(field: &'static str, message: &'static str) -> KernelError {
    KernelError::validation(message).with_field(field)
}

/// Shape rules of the change for `event_type` (already upper-cased).
/// `contract_end_date` is the request's, already a valid date when present.
///
/// # Errors
/// 422 validation naming the field.
pub fn normalize_classification_change(
    event_type: &str,
    mut change: ClassificationChange,
    contract_end_date: Option<&str>,
) -> Result<ClassificationChange, KernelError> {
    change.to_job = normalize_optional_limited_text(change.to_job, 200, "to_job")?;
    if change.to_job_id.is_some() {
        // By catalog id the label is projected when the event is prepared.
        change.to_job = None;
    }
    change.to_employment_type = change
        .to_employment_type
        .map(normalize_enum_text)
        .filter(|value| !value.is_empty());
    let appoint = change.to_position_kind_id.is_some()
        || change.vacate_position_kind
        || change.to_job_id.is_some()
        || change.to_job.is_some()
        || change.to_job_family_id.is_some();
    if change.to_grade_id.is_some() && event_type != "PROMOTE" {
        return Err(refuse(
            "to_grade_id",
            "to_grade_id is only allowed for PROMOTE",
        ));
    }
    if appoint != (event_type == "APPOINT") {
        return Err(refuse(
            "to_position_kind_id",
            "APPOINT needs one of to_position_kind_id, vacate_position_kind, to_job_id, to_job or to_job_family_id, which no other event takes",
        ));
    }
    if change.vacate_position_kind && change.to_position_kind_id.is_some() {
        return Err(refuse(
            "vacate_position_kind",
            "vacate_position_kind and to_position_kind_id exclude each other",
        ));
    }
    let to_type = change.to_employment_type.as_deref();
    if to_type.is_some() != (event_type == "EMPLOYMENT_TYPE_CHANGE") {
        return Err(refuse(
            "to_employment_type",
            "to_employment_type is required for EMPLOYMENT_TYPE_CHANGE and allowed for nothing else",
        ));
    }
    if to_type.is_some_and(|value| !EMPLOYMENT_TYPES.contains(&value)) {
        return Err(refuse(
            "to_employment_type",
            "to_employment_type must be one of the employment types",
        ));
    }
    if to_type.is_some() && (to_type == Some("CONTRACT")) != contract_end_date.is_some() {
        return Err(refuse(
            "contract_end_date",
            "a change to CONTRACT needs contract_end_date, and only that change takes one",
        ));
    }
    Ok(change)
}

/// The events that keep the employee's status (it is resolved to the one the
/// event meets).
pub fn keeps_status(event_type: &str) -> bool {
    matches!(
        event_type,
        "CONTRACT_RENEWAL" | "APPOINT" | "EMPLOYMENT_TYPE_CHANGE"
    )
}

/// The 직급·직책·직무·직군 the event leaves.
pub fn classification_after(
    head: &EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
) -> Classification {
    let mut after = head.classification.clone();
    let change = &transition.classify;
    match transition.event_type.as_str() {
        "PROMOTE" => after.grade_id = change.to_grade_id.or(after.grade_id),
        "APPOINT" => {
            if change.vacate_position_kind {
                after.position_kind_id = None;
            } else if change.to_position_kind_id.is_some() {
                after.position_kind_id = change.to_position_kind_id;
            }
            if change.to_job_id.is_some() || change.to_job.is_some() {
                // By id the label is filled in when prepared; by text the id
                // is cleared.
                after.job_id = change.to_job_id;
                if change.to_job.is_some() {
                    after.job.clone_from(&change.to_job);
                }
            }
            after.job_family_id = change.to_job_family_id.or(after.job_family_id);
        }
        _ => {}
    }
    after
}

// a 전환 to CONTRACT does not run BW-12's two-year check
// (`check_fixed_term_renewal`); the next CONTRACT_RENEWAL does, and the fold
// counts earlier windows. Run it on the 전환 too once the 노무사 confirms
// whether a 무기 period between two fixed-term windows breaks 계속근로.
/// The employment window a 전환 leaves (`None` for any other event): a change
/// to CONTRACT opens a window from the effective date to the given end; a
/// change away from it closes the window.
pub fn employment_window_after(
    transition: &NormalizedEmployeeLifecycleTransition,
) -> Option<EmploymentWindow> {
    let employment_type = transition.classify.to_employment_type.clone()?;
    let contract = employment_type == "CONTRACT";
    let date = |value: Option<&str>| value.and_then(|v| parse_yyyy_mm_dd(v).ok());
    Some(EmploymentWindow {
        contract_start_date: contract
            .then(|| date(Some(&transition.effective_date)))
            .flatten(),
        contract_end_date: contract
            .then(|| date(transition.contract_end_date.as_deref()))
            .flatten(),
        employment_type,
    })
}

/// Projects the event's catalog and employment effects onto `head` (the
/// schedule fold and the head an immediate event leaves).
pub fn project_classification(
    head: &mut EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
) {
    head.classification = classification_after(head, transition);
    if let Some(window) = employment_window_after(transition) {
        head.employment_type = Some(window.employment_type);
        head.contract_start_date = window.contract_start_date;
        head.contract_end_date = window.contract_end_date;
    }
    if transition.event_type == "CONTRACT_RENEWAL" {
        head.contract_end_date = transition
            .contract_end_date
            .as_deref()
            .and_then(|end| parse_yyyy_mm_dd(end).ok());
    }
}

/// Whether a PROMOTE, APPOINT or 전환 changes nothing (`None` for any other
/// event). A PROMOTE compares its 직위 text (projected from a catalog id) and
/// its 직급.
pub fn classification_noop(
    head: &EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
) -> Option<bool> {
    let change = &transition.classify;
    let unchanged = match transition.event_type.as_str() {
        "PROMOTE" => {
            transition
                .to_position
                .as_ref()
                .is_none_or(|to| head.position.as_ref() == Some(to))
                && change
                    .to_grade_id
                    .is_none_or(|to| head.classification.grade_id == Some(to))
        }
        "APPOINT" => classification_after(head, transition) == head.classification,
        "EMPLOYMENT_TYPE_CHANGE" => head.employment_type == change.to_employment_type,
        _ => return None,
    };
    Some(unchanged)
}

/// The before/after columns the ledger row keeps for a PROMOTE (직급), an
/// APPOINT or a 전환, so a rescission restores the head. Empty otherwise.
/// Serialized flat into the lifecycle event read (absent fields omitted).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ClassificationColumns {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_grade_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_grade_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_position_kind_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_position_kind_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_job_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_job_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_job_family_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_job_family_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_job: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_job: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_employment_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_employment_type: Option<String>,
    /// Restore-only (the read shows the event's own contract dates).
    #[serde(skip)]
    pub from_contract_start_date: Option<Date>,
}

pub fn classification_columns(
    head: &EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
) -> ClassificationColumns {
    let before = &head.classification;
    let after = classification_after(head, transition);
    match transition.event_type.as_str() {
        "PROMOTE" if transition.classify.to_grade_id.is_some() => ClassificationColumns {
            from_grade_id: before.grade_id,
            to_grade_id: after.grade_id,
            ..ClassificationColumns::default()
        },
        "APPOINT" => ClassificationColumns {
            from_position_kind_id: before.position_kind_id,
            to_position_kind_id: after.position_kind_id,
            from_job_id: before.job_id,
            to_job_id: after.job_id,
            from_job_family_id: before.job_family_id,
            to_job_family_id: after.job_family_id,
            from_job: before.job.clone(),
            to_job: after.job,
            ..ClassificationColumns::default()
        },
        "EMPLOYMENT_TYPE_CHANGE" => ClassificationColumns {
            from_employment_type: head.employment_type.clone(),
            to_employment_type: transition.classify.to_employment_type.clone(),
            from_contract_start_date: head.contract_start_date,
            ..ClassificationColumns::default()
        },
        _ => ClassificationColumns::default(),
    }
}

#[cfg(test)]
#[path = "classification_tests.rs"]
mod tests;

fn deserialize_enum_25<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_optional_enum_string(
        deserializer,
        &[
            "REGULAR",
            "CONTRACT",
            "PART_TIME",
            "INTERN",
            "DAILY",
            "EXECUTIVE",
            "DISPATCHED_IN",
            "OUTSOURCED_ON_SITE",
            "FREELANCE",
        ],
    )
}
