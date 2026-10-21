//! Pure lifecycle schedule projection: which events may be scheduled and the
//! head a scheduled event leaves.

use uuid::Uuid;

use super::classification::project_classification;
use super::event::{EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition};

/// The event types that may be dated after today (KST) and so SCHEDULED.
/// TERMINATE is scheduled only by an exit case's HR confirmation.
pub const SCHEDULABLE_LIFECYCLE_EVENT_TYPES: [&str; 9] = [
    "TRANSFER",
    "GROUP_TRANSFER",
    "PROMOTE",
    "APPOINT",
    "EMPLOYMENT_TYPE_CHANGE",
    "LEAVE_OF_ABSENCE",
    "RETURN_FROM_LEAVE",
    "CONTRACT_RENEWAL",
    "TERMINATE",
];

/// What changes in an employee's timeline, for [`replay_lifecycle_schedule`].
pub enum ScheduleChange<'a> {
    /// The head changes now (an immediate event); every SCHEDULED event follows.
    Head(Box<EmployeeForLifecycle>),
    /// A new SCHEDULED event enters the timeline after the existing events of
    /// its date.
    Insert(&'a mut NormalizedEmployeeLifecycleTransition),
    /// This SCHEDULED event leaves the timeline.
    Withdraw(Uuid),
}

/// One SCHEDULED event in an employee's timeline.
pub struct ScheduledLifecycleRow {
    pub id: Uuid,
    pub event_type: String,
    pub effective_date: String,
    /// The unit name the event projects (resolved when it was scheduled).
    pub to_org_unit: Option<String>,
    pub exit_owned: bool,
    pub transition: Option<NormalizedEmployeeLifecycleTransition>,
}

/// The head after `transition`, as the runner will leave it (without its
/// database lookups: `unit_name` is the unit's name when it was scheduled).
pub fn project_lifecycle_head(
    head: &mut EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
    unit_name: Option<&str>,
) {
    head.employment_status = transition.to_status.clone();
    if let Some(company) = &transition.to_company {
        head.company = company.clone();
    }
    match (transition.to_org_unit_id, &transition.to_org_unit) {
        (Some(unit), _) => {
            head.org_unit_id = Some(unit);
            if let Some(name) = unit_name {
                head.org_unit = Some(name.to_owned());
            }
        }
        (None, Some(text)) => {
            head.org_unit = Some(text.clone());
            head.org_unit_id = None;
        }
        (None, None) => {}
    }
    if let Some(position) = &transition.to_position {
        head.position = Some(position.clone());
    }
    // A PROMOTE of the 직위 sets the catalog title too: by id, or cleared by
    // free text (a 직급-only PROMOTE keeps it).
    if transition.event_type == "PROMOTE" && transition.to_position.is_some() {
        head.job_title_id = transition.to_job_title_id;
    }
    project_classification(head, transition);
}
