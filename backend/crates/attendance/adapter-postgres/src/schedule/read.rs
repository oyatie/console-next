//! Schedule reads: the scope tree, one scope's month, and one's own month.

use console_attendance_application::CallerScope;
use console_attendance_application::schedule::{
    LayerSummary, ScheduleCalendar, ScheduleDay, ShiftRead, StackEntry,
};
use console_attendance_domain::schedule::{LayerRef, Level, winner};
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use sqlx::{Postgres, Transaction};
use time::{Date, Duration, Month};
use uuid::Uuid;

use super::layers::scope_name;
use super::org::{Person, load_org, load_roster};
use super::preview::authorize_scope;
use super::universe::{StoredLayer, Universe, today_kst};
use super::{ScheduleStoreError, codes};
use crate::PgAttendanceStore;

pub(super) fn summary(u: &Universe, l: &StoredLayer) -> LayerSummary {
    LayerSummary {
        layer_id: l.id,
        pattern_id: l.pattern_id,
        pattern_name: u
            .patterns
            .get(&l.pattern_id)
            .map(|p| p.name.clone())
            .unwrap_or_default(),
        effective_from: l.from,
        effective_to: l.to,
        version: l.version,
    }
}

/// The layer held at exactly this scope on `date`.
pub(super) fn own_layer(u: &Universe, level: Level, id: Uuid, date: Date) -> Option<&StoredLayer> {
    u.layers
        .iter()
        .filter(|l| {
            l.level == level && l.scope_id == id && l.from <= date && l.to.is_none_or(|t| date < t)
        })
        .max_by_key(|l| (l.from, l.version))
}

fn month_range(month: &str) -> Result<(Date, Date), ScheduleStoreError> {
    let bad = || ScheduleStoreError::Invalid(codes::MONTH_INVALID);
    let (y, m) = month.split_once('-').ok_or_else(bad)?;
    let y: i32 = y.parse().map_err(|_| bad())?;
    let m = m
        .parse::<u8>()
        .ok()
        .and_then(|m| Month::try_from(m).ok())
        .ok_or_else(bad)?;
    let first = Date::from_calendar_date(y, m, 1).map_err(|_| bad())?;
    let next = (first.replace_day(28).map_err(|_| bad())? + Duration::days(4))
        .replace_day(1)
        .map_err(|_| bad())?;
    Ok((first, next - Duration::days(1)))
}

pub(crate) fn shift_read(s: &console_attendance_domain::schedule::Shift) -> ShiftRead {
    ShiftRead {
        start: s.start,
        end: s.end,
        breaks: s.breaks.clone(),
        minutes: s.minutes(),
        night_minutes: s.night_minutes(),
    }
}

fn stack(u: &Universe, p: &Person, refs: &[LayerRef], at: Date) -> Vec<StackEntry> {
    let win = winner(refs, at).map(|w| w.id);
    let mut out = Vec::new();
    let mut push = |level: Level, id: Option<Uuid>| {
        let layer = id.and_then(|id| own_layer(u, level, id, at));
        out.push(StackEntry {
            level,
            scope_id: id,
            scope_name: id.map(|id| scope_name(u, level, id, Some(p.name.clone()))),
            wins: layer.is_some_and(|l| Some(l.id) == win),
            layer: layer.map(|l| summary(u, l)),
        });
    };
    if p.id != Uuid::nil() {
        push(Level::Person, Some(p.id));
    }
    if p.crew.is_some() {
        push(Level::Crew, p.crew);
    }
    let chain = p.unit.map(|x| u.org.chain(x)).unwrap_or_default();
    let dept = chain
        .iter()
        .find(|(d, _)| own_layer(u, Level::Department, *d, at).is_some())
        .or(chain.first())
        .map(|(d, _)| *d);
    push(Level::Department, dept);
    push(Level::Workplace, p.workplace_id);
    push(Level::LegalEntity, p.legal_entity_id);
    out
}

async fn calendar_for(
    tx: &mut Transaction<'_, Postgres>,
    u: &Universe,
    level: Level,
    id: Uuid,
    month: &str,
    person: Option<Person>,
) -> Result<ScheduleCalendar, ScheduleStoreError> {
    let (first, last) = month_range(month)?;
    let today = today_kst();
    let at = if (first..=last).contains(&today) {
        today
    } else {
        first
    };
    let base = match &person {
        Some(p) => p.clone(),
        None => u
            .stand_in(level, id)
            .ok_or(ScheduleStoreError::NotFound(codes::SCOPE_NOT_FOUND))?,
    };
    let mut days = Vec::new();
    let mut d = first;
    while d <= last {
        // one roster read per day for a person (31 small reads), so a
        // mid-month 전근 shows on its day; batch by assignment range if it shows.
        let p = match &person {
            Some(_) => load_roster(tx, d, Some(id))
                .await?
                .pop()
                .unwrap_or_else(|| base.clone()),
            None => base.clone(),
        };
        let refs = u.layers_for(&p);
        let (w, plan) = u.day(&p, &refs, d);
        days.push(ScheduleDay {
            date: d,
            kind: plan.kind,
            shift: plan.shift.as_ref().map(shift_read),
            slot_code: plan.slot_code,
            holiday_name: plan.holiday_name,
            holiday_work: plan.holiday_work,
            decided_by: w.as_ref().map(|w| w.level),
            layer_id: w.map(|w| w.id),
        });
        d += Duration::days(1);
    }
    let refs = u.layers_for(&base);
    let upcoming = u
        .layers
        .iter()
        .filter(|l| l.from > at && refs.iter().any(|r| r.id == l.id))
        .map(|l| summary(u, l))
        .collect();
    Ok(ScheduleCalendar {
        scope_kind: level,
        scope_id: id,
        scope_name: scope_name(u, level, id, Some(base.name.clone())),
        month: month.to_owned(),
        stack: stack(u, &base, &refs, at),
        upcoming,
        days,
        holidays_loaded: u.holidays_loaded(first.year()),
    })
}

impl PgAttendanceStore {
    pub async fn schedule_calendar(
        &self,
        caller: &CallerScope,
        level: Level,
        id: Uuid,
        month: String,
    ) -> Result<ScheduleCalendar, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let (first, _) = month_range(&month)?;
                    let org = load_org(tx).await?;
                    let u = Universe::load(tx, org, (first.year(), first.year())).await?;
                    let at = today_kst().max(first);
                    let roster = if level == Level::Person {
                        load_roster(tx, at, Some(id)).await?
                    } else {
                        Vec::new()
                    };
                    let roster = if roster.is_empty() && level == Level::Person {
                        load_roster(tx, first, Some(id)).await?
                    } else {
                        roster
                    };
                    authorize_scope(&caller, &u, &roster, level, id)?;
                    calendar_for(tx, &u, level, id, &month, roster.into_iter().next()).await
                })
            },
        )
        .await
    }

    pub async fn own_schedule(
        &self,
        org: Uuid,
        user: Uuid,
        month: String,
    ) -> Result<ScheduleCalendar, ScheduleStoreError> {
        with_org_conn::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(org), move |tx| {
            Box::pin(async move {
                let (first, last) = month_range(&month)?;
                let employee: Option<Uuid> =
                    sqlx::query_scalar("SELECT employee_id FROM users WHERE id = $1")
                        .bind(user)
                        .fetch_optional(tx.as_mut())
                        .await?
                        .flatten();
                let employee = employee.ok_or(ScheduleStoreError::Forbidden)?;
                let org = load_org(tx).await?;
                let u = Universe::load(tx, org, (first.year(), first.year())).await?;
                let mut roster =
                    load_roster(tx, today_kst().clamp(first, last), Some(employee)).await?;
                if roster.is_empty() {
                    roster = load_roster(tx, first, Some(employee)).await?;
                }
                let me = roster
                    .pop()
                    .ok_or(ScheduleStoreError::NotFound(codes::SCOPE_NOT_FOUND))?;
                calendar_for(tx, &u, Level::Person, employee, &month, Some(me)).await
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::month_range;
    use time::macros::date;

    #[test]
    fn a_month_spans_its_first_to_last_day() {
        assert_eq!(
            month_range("2026-02").unwrap(),
            (date!(2026 - 02 - 01), date!(2026 - 02 - 28))
        );
        assert_eq!(
            month_range("2026-12").unwrap(),
            (date!(2026 - 12 - 01), date!(2026 - 12 - 31))
        );
        assert!(month_range("2026-13").is_err());
        assert!(month_range("x").is_err());
    }
}
