// SPDX-License-Identifier: LicenseRef-Proprietary
//! One register/settings snapshot for both weekly read projections.
use std::collections::{BTreeMap, BTreeSet};

use console_attendance_application::{
    self as app, Week52Limits, Week52Read, week52::WARN_HOURS_KEY,
};
use console_kernel_core::OrgId;
use console_platform_db::{
    settings_read::resolve_in_tx,
    statutory_read::{StatutoryUnit, codes, load_statutory_register},
};
use sqlx::PgConnection;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::{
    AttendanceStoreError, BoardReadTarget, PgAttendanceStore, ScheduleStoreError, records,
    schedule, strict_duration_event_kind, week52_boundary, week52_hours,
};
use console_attendance_application::CallerScope;
use console_attendance_domain::{StrictDurationEvent, schedule::Level};
use console_platform_db::with_org_conn;
use sqlx::{Postgres, Row, Transaction};
use time::Duration;

pub(crate) async fn load_limits(
    conn: &mut PgConnection,
    org: OrgId,
    on: Date,
) -> Result<Option<Week52Limits>, AttendanceStoreError> {
    let register = load_statutory_register(conn)
        .await
        .map_err(|_| AttendanceStoreError::WeeklyPolicyUnavailable)?;
    let (Ok(standard), Ok(overtime)) = (
        register.rule(codes::WEEKLY_STANDARD_HOURS, on),
        register.rule(codes::WEEKLY_OVERTIME_MAX_HOURS, on),
    ) else {
        return Ok(None);
    };
    let standard = standard
        .whole(StatutoryUnit::HoursPerWeek)
        .map_err(|_| AttendanceStoreError::WeeklyPolicyUnavailable)?;
    let overtime = overtime
        .whole(StatutoryUnit::HoursPerWeek)
        .map_err(|_| AttendanceStoreError::WeeklyPolicyUnavailable)?;
    let settings = resolve_in_tx(
        conn,
        org,
        &[WARN_HOURS_KEY],
        None,
        crate::week52_boundary(on)?,
    )
    .await
    .map_err(|_| AttendanceStoreError::WeeklyPolicyUnavailable)?;
    let warn = settings
        .get(&WARN_HOURS_KEY)
        .and_then(|value| value.as_ref().ok())
        .and_then(|value| value.value.as_int())
        .ok_or(AttendanceStoreError::WeeklyPolicyUnavailable)?;
    let danger = standard
        .checked_add(overtime)
        .ok_or(AttendanceStoreError::WeeklyPolicyUnavailable)?;
    if standard <= 0 {
        return Ok(None);
    }
    Ok(Some(Week52Limits {
        danger_hours: danger as f64,
        warn_hours: (warn >= standard && warn < danger).then_some(warn as f64),
    }))
}

pub(super) fn week52_inputs_for_active(
    active_employees: impl IntoIterator<Item = (Uuid, String, Option<String>)>,
    week_start: Date,
    hours: BTreeMap<Uuid, f64>,
    acknowledgements: BTreeMap<Uuid, OffsetDateTime>,
    limits: Option<app::Week52Limits>,
) -> Vec<Week52Read> {
    active_employees
        .into_iter()
        .map(|(employee_id, name, team)| {
            let current_hours = hours.get(&employee_id).copied().unwrap_or(0.0);
            Week52Read {
                employee_id,
                name,
                team,
                week_start,
                current_hours,
                projected_hours: current_hours,
                recognized_hours: None,
                overtime_hours: None,
                tone: limits.map_or(app::Week52Tone::Unknown, |limits| {
                    app::week52_tone(
                        &app::Week52Input {
                            employee_id,
                            week_start,
                            current_hours,
                            projected_hours: current_hours,
                            acknowledged_at: acknowledgements.get(&employee_id).copied(),
                        },
                        limits,
                    )
                }),
                acknowledged_at: acknowledgements.get(&employee_id).copied(),
            }
        })
        .collect()
}

/// Load the same dated plans and current entry revisions as the attendance grid.
async fn load_totals(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    first: Date,
    members: Vec<crate::records::roster::Member>,
    org: crate::schedule::org::OrgModel,
) -> Result<BTreeMap<Uuid, Option<(f64, f64)>>, crate::ScheduleStoreError> {
    use crate::{records::entries::current, schedule::universe::Universe};
    use console_attendance_domain::{
        records::{EntryKind, evaluate},
        schedule::DayKind,
    };
    use sqlx::Row;

    let last = first + time::Duration::days(6);
    let universe = Universe::load(tx, org, (first.year(), last.year())).await?;
    let people: Vec<_> = members.iter().map(|m| m.id).collect();
    let entries = current(tx, first, last, Some(&people)).await?;
    let mut approvals = BTreeMap::new();
    for row in sqlx::query("SELECT e.employee_id,e.work_date,CASE WHEN COUNT(*)=COUNT(r.ot_hours) THEN SUM(r.ot_hours)::float8 END AS hours FROM attendance_exceptions e JOIN attendance_exception_resolutions r ON r.exception_id=e.id AND r.org_id=e.org_id WHERE e.kind='UNAPPROVED_OVERTIME' AND e.status='RESOLVED' AND r.action='APPROVE_OVERTIME' AND e.work_date BETWEEN $1 AND $2 AND e.employee_id=ANY($3) GROUP BY e.employee_id,e.work_date")
        .bind(first).bind(last).bind(&people).fetch_all(tx.as_mut()).await? {
        approvals.insert((row.try_get::<Uuid,_>("employee_id")?, row.try_get::<Date,_>("work_date")?), row.try_get::<Option<f64>,_>("hours")?);
    }
    let mut totals = BTreeMap::new();
    for member in members {
        let mut total = Some((0.0, 0.0));
        let mut reported = false;
        for offset in 0..7 {
            let date = first + time::Duration::days(offset);
            let Some(entry) = entries.get(&(member.id, date)) else {
                continue;
            };
            if entry.kind == EntryKind::Void {
                continue;
            }
            reported = true;
            let Some(person) = member.on(date) else {
                total = None;
                break;
            };
            let (_, plan) = universe.day(&person, &universe.layers_for(&person), date);
            if plan.kind == DayKind::NoSchedule || entry.kind == EntryKind::ClockInOnly {
                total = None;
                break;
            }
            let (_, recognition) = evaluate(&plan, Some(entry.kind), &entry.segments, &[]);
            let approved = approvals
                .get(&(member.id, date))
                .copied()
                .unwrap_or(Some(0.0));
            total = total
                .zip(app::week52::approved_day_hours(&recognition, approved))
                .map(|((r, o), (day_r, day_o))| (r + day_r, o + day_o));
        }
        totals.insert(member.id, total.filter(|_| reported));
    }
    Ok(totals)
}

impl PgAttendanceStore {
    pub async fn week52_inputs<F>(
        &self,
        caller: &CallerScope,
        week_start: Date,
        branch_id: Option<Uuid>,
        load_access: F,
    ) -> Result<Vec<Week52Read>, AttendanceStoreError>
    where
        F: for<'a> FnOnce(
                &'a mut Transaction<'_, Postgres>,
            ) -> crate::records::BoardAccessFuture<'a>
            + Send
            + 'static,
    {
        app::validate_week52_start(week_start)?;
        let org = OrgId::from_uuid(caller.org_id);
        let end = week_start + Duration::days(7);
        let week_start_at = week52_boundary(week_start)?;
        let week_end_at = week52_boundary(end)?;
        with_org_conn::<_, _, AttendanceStoreError>(&self.pool, org, move |tx| Box::pin(async move {
            let access = load_access(tx).await?;
            let limits = load_limits(tx.as_mut(), org, week_start).await?;
            let org_model = schedule::org::load_org(tx).await?;
            if let Some(branch) = branch_id {
                let workplaces: Vec<_> = org_model.workplaces.iter().filter(|(_, w)| w.branch_id == Some(branch)).map(|(id, _)| *id).collect();
                if workplaces.is_empty() && !access(BoardReadTarget::Person { workplace: None })? {
                    return Err(ScheduleStoreError::Forbidden.into());
                }
                for id in workplaces {
                    if !access(BoardReadTarget::Scope(Level::Workplace, id))? {
                        return Err(ScheduleStoreError::Forbidden.into());
                    }
                }
            }
            let active_employees = sqlx::query_as::<_, (Uuid, String, Option<String>)>("SELECT id,name,org_unit FROM person_employees_current WHERE employment_status='ACTIVE' AND ($1::uuid IS NULL OR home_branch_id=$1) ORDER BY id")
                .bind(branch_id).fetch_all(tx.as_mut()).await?;
            let ids: Vec<_> = active_employees.iter().map(|(id, _, _)| *id).collect();
            let mut members: BTreeMap<_, _> = records::roster::load_members(tx, week_start, end - Duration::days(1), Some(&ids)).await?.into_iter().map(|m| (m.id, m)).collect();
            let mut visible = Vec::new();
            for employee in active_employees {
                let member = members.get(&employee.0);
                let mut workplaces: BTreeSet<_> = (0..7).filter_map(|offset| member.and_then(|m| m.on(week_start + Duration::days(offset)))).map(|p| p.workplace_id).collect();
                if workplaces.is_empty() { workplaces.insert(None); }
                let mut allowed = true;
                for workplace in workplaces {
                    allowed &= access(BoardReadTarget::Person { workplace })?;
                }
                if allowed { visible.push(employee); }
            }
            let active_employees = visible;
            let ids: Vec<_> = active_employees.iter().map(|(id, _, _)| *id).collect();
            let totals = load_totals(tx, week_start, ids.iter().filter_map(|id| members.remove(id)).collect(), org_model).await?;
            // Pair the complete employee timeline. Filtering by `work_date` (or by either
            // week boundary) loses a side of a shift that crosses that boundary.
            let rows = sqlx::query("SELECT r.id,r.employee_id,r.kind,r.occurred_at FROM employee_attendance_records r JOIN employees e ON e.id=r.employee_id AND e.org_id=r.org_id WHERE e.employment_status='ACTIVE' AND r.employee_id=ANY($1) ORDER BY r.employee_id,r.occurred_at,r.id")
                .bind(&ids).fetch_all(tx.as_mut()).await?;
            let events = rows.iter().map(|row| Ok(StrictDurationEvent {
                id: row.try_get("id")?,
                employee_id: row.try_get("employee_id")?,
                kind: strict_duration_event_kind(&row.try_get::<String, _>("kind")?),
                occurred_at: row.try_get("occurred_at")?,
            })).collect::<Result<Vec<_>, AttendanceStoreError>>()?;
            let hours = week52_hours(&events, week_start_at, week_end_at)?;
            let acknowledgements = sqlx::query("SELECT a.employee_id,a.acknowledged_at FROM attendance_week52_acknowledgements a JOIN employees e ON e.id=a.employee_id AND e.org_id=a.org_id WHERE a.week_start=$1 AND e.employment_status='ACTIVE' AND ($2::uuid IS NULL OR e.home_branch_id=$2)")
                .bind(week_start).bind(branch_id).fetch_all(tx.as_mut()).await?.into_iter().map(|row| Ok((row.try_get::<Uuid,_>("employee_id")?, row.try_get::<OffsetDateTime,_>("acknowledged_at")?))).collect::<Result<BTreeMap<_,_>, AttendanceStoreError>>()?;
            let mut rows = week52_inputs_for_active(active_employees, week_start, hours, acknowledgements, limits);
            for row in &mut rows {
                let total = totals.get(&row.employee_id).copied().flatten();
                row.recognized_hours = total.map(|(r, _)| r);
                row.overtime_hours = total.map(|(_, o)| o);
            }
            Ok(rows)
        })).await
    }
}
