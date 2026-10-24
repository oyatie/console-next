//! Validates a lifecycle event against the head it will meet.

use console_hr_domain::lifecycle::classification::{
    Classification, EmploymentWindow, classification_after, employment_window_after,
    project_classification,
};
use console_hr_domain::lifecycle::event::{
    EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition,
};
use console_hr_domain::lifecycle::schedule::{SCHEDULABLE_LIFECYCLE_EVENT_TYPES, ScheduleChange};
use console_hr_domain::text::{normalize_enum_text, parse_yyyy_mm_dd};
use console_kernel_core::ChangeMode;
use sqlx::Postgres;
use time::Date;
use uuid::Uuid;

use super::classification::fill_classification;
use super::placement::{
    WorkplaceMove, lifecycle_change_mode, receiving_label, resolve_workplace_move,
};
use super::rules::validate_lifecycle_transition;
use super::schedule_sql::replay_lifecycle_schedule;
use super::store::load_employee_for_lifecycle;
use super::title_reason::{fill_promote_title, promote_target_title};
use crate::HrError;
use crate::directory::create::require_assignable_org_unit;

/// A lifecycle event validated against the head it will meet, ready to record.
/// `scheduled` is decided once, by the caller's single read of today (KST), so
/// validation and recording can never disagree across midnight.
pub struct PreparedLifecycleEvent {
    /// The head the event meets: live for an immediate event; for a scheduled
    /// one, the live head with every SCHEDULED event before it folded in.
    pub current: EmployeeForLifecycle,
    pub transition: NormalizedEmployeeLifecycleTransition,
    pub target: LifecycleTarget,
    pub scheduled: bool,
    /// The SCHEDULED event of the same kind and date this one corrects.
    pub replaces: Option<Uuid>,
    /// BW-11: the `lifecycle_cancel` code the explicit replacement records.
    pub replace_reason_code: Option<String>,
    /// BW-11: the APPLIED event this one corrects.
    pub voids_event_id: Option<Uuid>,
    /// A leave or transfer's admission (`SETUP` = a setup record, decisions
    /// #26); `None` for an act the phase does not govern.
    pub change_mode: Option<ChangeMode>,
}

/// Locks the employee and validates `transition` against the head it will
/// meet: the live head for an immediate event (exit last working day before
/// `today`, other events dated `today` or earlier, KST); for a scheduled one,
/// the live head with every SCHEDULED event before
/// it folded in (by date, then recording order; a same-kind same-date event
/// that no exit case owns is the one it replaces). The employee's later
/// SCHEDULED events are then re-validated against the head this event leaves,
/// and any that would no longer apply refuse the event (409
/// `lifecycle_schedule_conflict`, naming each). Resolves a CONTRACT_RENEWAL's
/// status against the head it meets.
pub async fn prepare_lifecycle_event(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_id: Uuid,
    mut transition: NormalizedEmployeeLifecycleTransition,
    today: Date,
) -> Result<PreparedLifecycleEvent, HrError> {
    let change_mode = lifecycle_change_mode(tx, org_uuid, &transition.event_type).await?;
    let live = load_employee_for_lifecycle(tx, org_uuid, employee_id).await?;
    fill_promote_title(tx, org_uuid, &mut transition).await?;
    fill_classification(tx, org_uuid, &mut transition).await?;
    // Exit dates store 마지막 근무일: employment ends only after that day.
    let effective_date = parse_yyyy_mm_dd(&transition.effective_date)?;
    let scheduled = if matches!(transition.event_type.as_str(), "TERMINATE" | "OFFBOARD") {
        console_entity_adapter_postgres::employment_end::retirement_date(effective_date) > today
    } else {
        effective_date > today
    };
    if scheduled {
        if !SCHEDULABLE_LIFECYCLE_EVENT_TYPES.contains(&transition.event_type.as_str()) {
            return Err(HrError::validation(
                "ONBOARD cannot be scheduled; effective_date must not be in the future (KST)",
            ));
        }
        let (current, replaces) = replay_lifecycle_schedule(
            tx,
            org_uuid,
            employee_id,
            &live,
            ScheduleChange::Insert(&mut transition),
        )
        .await?;
        let target =
            resolve_lifecycle_target(tx, org_uuid, employee_id, &current, &transition).await?;
        return Ok(PreparedLifecycleEvent {
            current,
            transition,
            target,
            scheduled,
            replaces,
            replace_reason_code: None,
            voids_event_id: None,
            change_mode,
        });
    }
    if transition.to_status.is_empty() {
        transition.to_status = normalize_enum_text(live.employment_status.clone());
    }
    validate_lifecycle_transition(&live, &transition)?;
    let target = resolve_lifecycle_target(tx, org_uuid, employee_id, &live, &transition).await?;
    let mut after = live.clone();
    after.employment_status = transition.to_status.clone();
    after.company = target.company.clone();
    after.org_unit = target.org_unit.clone();
    after.position = target.position.clone();
    after.job_title_id = target.job_title_id;
    project_classification(&mut after, &transition);
    if let Some(binding) = target.rebind {
        after.org_unit_id = binding;
    }
    replay_lifecycle_schedule(
        tx,
        org_uuid,
        employee_id,
        &live,
        ScheduleChange::Head(Box::new(after)),
    )
    .await?;
    Ok(PreparedLifecycleEvent {
        current: live,
        transition,
        target,
        scheduled,
        replaces: None,
        replace_reason_code: None,
        voids_event_id: None,
        change_mode,
    })
}

/// The employee head a lifecycle event leaves behind.
pub struct LifecycleTarget {
    pub company: String,
    pub org_unit: Option<String>,
    pub position: Option<String>,
    /// The catalog title after the event (BW-13).
    pub job_title_id: Option<Uuid>,
    /// `Some(binding)` when the unit binding changes.
    pub rebind: Option<Option<Uuid>>,
    /// E-S3b: the 사업장 a TRANSFER moves the employee to (전근).
    pub workplace: Option<WorkplaceMove>,
    /// MR-25: the 직급, 직책, 직무, 직군 after the event.
    pub classification: Classification,
    /// MR-24: the employment type and window a 전환 leaves.
    pub employment: Option<EmploymentWindow>,
}

pub async fn resolve_lifecycle_target(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_id: Uuid,
    current: &EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
) -> Result<LifecycleTarget, HrError> {
    // Binding change: a unit id rebinds (name projected into the text
    // column); a free-text-only org change drops a now-stale binding;
    // anything else keeps the current binding.
    let (org_unit, rebind) = match transition.to_org_unit_id {
        Some(org_unit_id) => {
            let name = require_assignable_org_unit(tx, org_uuid, org_unit_id).await?;
            (Some(name), Some(Some(org_unit_id)))
        }
        None if transition.to_org_unit.is_some() => (transition.to_org_unit.clone(), Some(None)),
        None => (current.org_unit.clone(), None),
    };
    let job_title_id = promote_target_title(tx, org_uuid, current, transition).await?;
    let workplace = resolve_workplace_move(
        tx,
        org_uuid,
        employee_id,
        transition,
        transition.to_org_unit_id,
    )
    .await?;
    // A 전근 asked for where the employee already works, with no unit change.
    if transition.to_workplace_id.is_some()
        && workplace.is_none()
        && transition
            .to_org_unit_id
            .is_none_or(|unit| current.org_unit_id == Some(unit))
    {
        return Err(HrError::lifecycle_noop(&transition.event_type));
    }
    Ok(LifecycleTarget {
        company: match (transition.event_type.as_str(), workplace) {
            // 전적: the display snapshot follows the receiving 법인 (ED §3.9).
            ("GROUP_TRANSFER", Some(to)) => {
                receiving_label(tx, org_uuid, to, &transition.effective_date)
                    .await?
                    .unwrap_or_else(|| current.company.clone())
            }
            _ => transition
                .to_company
                .clone()
                .unwrap_or_else(|| current.company.clone()),
        },
        org_unit,
        position: transition
            .to_position
            .clone()
            .or_else(|| current.position.clone()),
        job_title_id,
        rebind,
        workplace,
        classification: classification_after(current, transition),
        employment: employment_window_after(transition),
    })
}
