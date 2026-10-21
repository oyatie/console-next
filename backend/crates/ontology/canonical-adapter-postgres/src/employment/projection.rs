//! The read shapes: an open head and the non-serving effective projection.

use super::error::EmploymentError;
use super::model::{EMPLOYMENT_STATUSES, EmploymentAttributes};
use time::OffsetDateTime;
use uuid::Uuid;

/// Canonical Employment state for an open head, or for an effective instant
/// inside a head's lifetime when read through `get_as_of`.
///
/// Not-yet-open and closed windows are omitted by list/get; `get_as_of` can return
/// their earlier state before `valid_to`. `org_unit_id` / `job_position_id`
/// come from the latest *effective* revision at the requested instant
/// (`MAX(valid_from)` — a backdated history insert is a later version with an
/// earlier effect). `person_id` is the unique current
/// source-binding → person-binding path; ambiguous or unbound identities are
/// omitted, never invented from `employee_id`. `appointed_on` is the head's
/// opening `valid_from`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmploymentHead {
    pub id: Uuid,
    pub person_id: Option<Uuid>,
    pub org_unit_id: Option<Uuid>,
    pub job_position_id: Option<Uuid>,
    pub appointed_on: OffsetDateTime,
}

/// Effective revision state, including bound employments not yet effective.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmploymentEffectiveStatus {
    NotYetEffective,
    Active,
    /// Leave of absence (0243): employed but not serving, so not active.
    OnLeave,
    Exited,
    Unknown,
}

/// Non-serving owner projection at one captured instant. Attributes are absent
/// before the first effective revision; only `Active` is active. Unlike
/// `EmploymentHead`, this projection retains exited and unknown states even
/// when the head's lifetime has closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmploymentEffectiveProjection {
    pub employment_id: Uuid,
    pub captured_as_of: OffsetDateTime,
    pub state: EmploymentEffectiveStatus,
    pub is_active: bool,
    pub company: Option<String>,
    pub org_unit_id: Option<Uuid>,
    pub job_position_id: Option<Uuid>,
}

pub(super) fn parse_effective_attributes(
    employment_id: Uuid,
    value: serde_json::Value,
) -> Result<EmploymentAttributes, EmploymentError> {
    let attributes: EmploymentAttributes = serde_json::from_value(value).map_err(|error| {
        EmploymentError::UnreadableEffectiveState {
            employment_id,
            reason: error.to_string(),
        }
    })?;
    if (!attributes.company.is_empty() && attributes.company.trim().is_empty())
        || !EMPLOYMENT_STATUSES.contains(&attributes.employment_status.as_str())
        || attributes.org_unit_id == Some(Uuid::nil())
        || attributes.job_position_id == Some(Uuid::nil())
    {
        return Err(EmploymentError::UnreadableEffectiveState {
            employment_id,
            reason: "invalid company, status, or reference".to_owned(),
        });
    }
    Ok(attributes)
}
