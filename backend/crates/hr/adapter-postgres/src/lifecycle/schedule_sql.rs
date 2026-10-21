//! Replays an employee's SCHEDULED events against a change.

use std::collections::BTreeMap;

use console_hr_domain::lifecycle::event::{
    EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition,
};
use console_hr_domain::lifecycle::schedule::{
    ScheduleChange, ScheduledLifecycleRow, project_lifecycle_head,
};
use console_hr_domain::text::normalize_enum_text;
use serde_json::{Value, json};
use sqlx::{Postgres, Row};
use uuid::Uuid;

use super::classification::resolve_kept_status;
use super::rules::validate_lifecycle_transition;
use crate::HrError;

/// Replays the employee's SCHEDULED events, in the order the runner applies
/// them, through `change`, validating each against the head it would meet.
/// Every event that applies without the change but would fail on its date
/// with it is a refusal: 409 `lifecycle_schedule_conflict` with
/// `error.refusals` naming each one (`lifecycle_event_id`, `event_type`,
/// `effective_date`, `code`, `message`). An event that fails either way (the
/// head drifted, e.g. by import) is left to fail on its date, and the head
/// passes it unchanged, as the runner would.
///
/// For [`ScheduleChange::Insert`], the inserted event itself is validated
/// against the head it meets (its CONTRACT_RENEWAL status resolved there), and
/// that head plus the same-kind same-date event it replaces are returned. A
/// state refusal caused by the projection (not the live head) is
/// `lifecycle_scheduled_state`, naming the scheduled event that causes it.
pub async fn replay_lifecycle_schedule(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_id: Uuid,
    live: &EmployeeForLifecycle,
    change: ScheduleChange<'_>,
) -> Result<(EmployeeForLifecycle, Option<Uuid>), HrError> {
    let rows = sqlx::query(
        "SELECT l.id, l.event_type, l.effective_date, l.to_org_unit, l.scheduled_request, \
                l.event_type <> 'GROUP_TRANSFER' AND EXISTS (SELECT 1 FROM employee_exit_cases c \
                        WHERE c.org_id = l.org_id AND c.exit_lifecycle_event_id = l.id) AS exit_owned \
         FROM employee_lifecycle_events l \
         WHERE l.org_id = $1 AND l.employee_id = $2 AND l.state = 'SCHEDULED' \
         ORDER BY l.effective_date, l.created_at",
    )
    .bind(org_uuid)
    .bind(employee_id)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .map(|row| {
        Ok(ScheduledLifecycleRow {
            id: row.try_get("id")?,
            event_type: row.try_get("event_type")?,
            effective_date: row.try_get("effective_date")?,
            to_org_unit: row.try_get("to_org_unit")?,
            exit_owned: row.try_get("exit_owned")?,
            transition: row
                .try_get::<Option<Value>, _>("scheduled_request")?
                .and_then(|request| serde_json::from_value(request).ok()),
        })
    })
    .collect::<Result<Vec<_>, sqlx::Error>>()?;

    let (_, baseline) = simulate_lifecycle_schedule(&rows, live, live.clone(), None, None)?;
    let (met, replaces, failures) = match change {
        ScheduleChange::Head(after) => {
            let (met, failures) = simulate_lifecycle_schedule(&rows, live, *after, None, None)?;
            (met, None, failures)
        }
        ScheduleChange::Insert(transition) => {
            let replaces = rows
                .iter()
                .find(|row| {
                    !row.exit_owned
                        && row.event_type == transition.event_type
                        && row.effective_date == transition.effective_date
                })
                .map(|row| row.id);
            let (met, failures) =
                simulate_lifecycle_schedule(&rows, live, live.clone(), Some(transition), replaces)?;
            (met, replaces, failures)
        }
        ScheduleChange::Withdraw(id) => {
            let (met, failures) =
                simulate_lifecycle_schedule(&rows, live, live.clone(), None, Some(id))?;
            (met, None, failures)
        }
    };
    let refusals: Vec<Value> = rows
        .iter()
        .filter(|row| !baseline.contains_key(&row.id))
        .filter_map(|row| {
            failures.get(&row.id).map(|(code, message)| {
                json!({
                    "lifecycle_event_id": row.id,
                    "event_type": row.event_type,
                    "effective_date": row.effective_date,
                    "code": code,
                    "message": message,
                })
            })
        })
        .collect();
    if !refusals.is_empty() {
        return Err(HrError::schedule_conflict(refusals));
    }
    Ok((met, replaces))
}

/// One pass of [`replay_lifecycle_schedule`]: `head` through `rows` (minus
/// `skip`), with `inserted` placed after the events of its date. Returns the
/// head the inserted event meets (else the final head) and each row's refusal.
// Moved verbatim from app/src/hr.rs; the refusal map stays inline (R2-life may name it).
#[allow(clippy::type_complexity)]
pub fn simulate_lifecycle_schedule(
    rows: &[ScheduledLifecycleRow],
    live: &EmployeeForLifecycle,
    mut head: EmployeeForLifecycle,
    mut inserted: Option<&mut NormalizedEmployeeLifecycleTransition>,
    skip: Option<Uuid>,
) -> Result<(EmployeeForLifecycle, BTreeMap<Uuid, (&'static str, String)>), HrError> {
    let live_status = normalize_enum_text(live.employment_status.clone());
    // The scheduled event that last changed the projected status, for a
    // refusal that names why the employee will stand differently.
    let mut status_by: Option<(String, String)> = None;
    let mut met = None;
    let mut failures = BTreeMap::new();
    let mut rows = rows.iter().filter(|row| Some(row.id) != skip).peekable();
    loop {
        let insert_now = match (&inserted, rows.peek()) {
            (Some(transition), Some(row)) => row.effective_date > transition.effective_date,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if insert_now && let Some(transition) = inserted.take() {
            if transition.to_status.is_empty() {
                transition.to_status = normalize_enum_text(head.employment_status.clone());
            }
            validate_lifecycle_transition(&head, transition).map_err(|error| {
                projected_lifecycle_refusal(error, &live_status, &head, status_by.as_ref())
            })?;
            met = Some(head.clone());
            project_lifecycle_head(&mut head, transition, None);
            continue;
        }
        let Some(row) = rows.next() else { break };
        let Some(mut transition) = row.transition.clone() else {
            continue;
        };
        resolve_kept_status(&mut transition, &head);
        match validate_lifecycle_transition(&head, &transition) {
            Ok(()) => {
                if transition.to_status != normalize_enum_text(head.employment_status.clone()) {
                    status_by = Some((row.event_type.clone(), row.effective_date.clone()));
                }
                project_lifecycle_head(&mut head, &transition, row.to_org_unit.as_deref());
            }
            Err(error) if error.status.is_client_error() => {
                failures.insert(row.id, (error.code, error.message));
            }
            Err(error) => return Err(error),
        }
    }
    Ok((met.unwrap_or(head), failures))
}

/// A state refusal met only because scheduled events change the employee
/// before this one: say so, instead of describing the live employee.
pub fn projected_lifecycle_refusal(
    error: HrError,
    live_status: &str,
    head: &EmployeeForLifecycle,
    status_by: Option<&(String, String)>,
) -> HrError {
    let projected = normalize_enum_text(head.employment_status.clone());
    match status_by {
        Some((event_type, date))
            if error.code == "invalid_transition" && projected != live_status =>
        {
            HrError::scheduled_state(&projected, date, event_type)
        }
        _ => error,
    }
}

/// The employee's SCHEDULED events (the rescission preview).
pub(super) async fn scheduled_cascades(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    employee: Uuid,
) -> Result<Vec<Value>, HrError> {
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT id, event_type, effective_date FROM employee_lifecycle_events \
         WHERE org_id = $1 AND employee_id = $2 AND state = 'SCHEDULED' \
         ORDER BY effective_date, created_at",
    )
    .bind(org)
    .bind(employee)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, kind, on)| json!({"kind": "scheduled_event", "lifecycle_event_id": id, "event_type": kind, "effective_date": on}))
        .collect())
}
