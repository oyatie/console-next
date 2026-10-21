//! 월간 근무표 (A3-grid) and one person's month (A7-card).

use console_attendance_application::CallerScope;
use console_attendance_application::records_read::{
    GridRow, GridTotals, HistoryRow, MonthGrid, PersonMonth,
};
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use time::{Date, Duration, Month};
use uuid::Uuid;

use super::day::{add, day_read, evaluate_day, grid_cell};
use super::entries::{current, history};
use super::roster::{load_members, own_employee};
use super::thresholds::RecordSettings;
use crate::PgAttendanceStore;
use crate::schedule::org::load_org;
use crate::schedule::preview::{branch_of, visible};
use crate::schedule::universe::{Universe, today_kst};
use crate::schedule::{Closes, ScheduleStoreError, codes};

pub(crate) fn month_range(month: &str) -> Result<(Date, Date), ScheduleStoreError> {
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

#[derive(Debug, Clone, Default)]
pub struct GridQuery {
    pub month: String,
    pub workplace_id: Option<Uuid>,
    pub unit_id: Option<Uuid>,
    pub cursor: Option<Uuid>,
    pub limit: usize,
}

impl PgAttendanceStore {
    pub async fn month_grid(
        &self,
        caller: &CallerScope,
        q: GridQuery,
    ) -> Result<MonthGrid, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let (first, last) = month_range(&q.month)?;
                    let today = today_kst();
                    let org = load_org(tx).await?;
                    let u = Universe::load(tx, org, (first.year(), first.year())).await?;
                    super::authorize_filters(&caller, &u, q.workplace_id, q.unit_id)?;
                    let own = own_employee(tx, caller.user_id).await?;
                    // A person belongs to the page when placed in scope on some day of the month.
                    let in_scope = |p: &crate::schedule::org::Person| {
                        visible(&caller, &u, p)
                            && q.workplace_id.is_none_or(|w| p.workplace_id == Some(w))
                            && q.unit_id.is_none_or(|x| {
                                p.unit.is_some_and(|unit| {
                                    u.org.chain(unit).iter().any(|(c, _)| *c == x)
                                })
                            })
                    };
                    let days: Vec<Date> = (0..=(last - first).whole_days())
                        .map(|i| first + Duration::days(i))
                        .collect();
                    let members: Vec<_> = load_members(tx, first, last, None)
                        .await?
                        .into_iter()
                        .filter(|m| days.iter().any(|d| m.on(*d).is_some_and(|p| in_scope(&p))))
                        .collect();
                    let total = i64::try_from(members.len()).unwrap_or(i64::MAX);
                    let start = q
                        .cursor
                        .and_then(|c| members.iter().position(|m| m.id == c).map(|i| i + 1))
                        .unwrap_or(0);
                    let limit = q.limit.clamp(1, 200);
                    let page: Vec<_> = members.into_iter().skip(start).take(limit + 1).collect();
                    let next_cursor = (page.len() > limit).then(|| page[limit - 1].id.to_string());
                    let page = &page[..page.len().min(limit)];
                    let settings = RecordSettings::load(
                        tx,
                        caller.org_id,
                        page.iter().flat_map(|m| m.setting_entities()),
                    )
                    .await?;
                    let ids: Vec<Uuid> = page.iter().map(|m| m.id).collect();
                    let mut entries = current(tx, first, last, Some(&ids)).await?;
                    let closes = Closes::load(tx).await?;
                    let rows = page
                        .iter()
                        .map(|m| {
                            let mut totals = GridTotals::default();
                            let branches: Vec<_> = days
                                .iter()
                                .filter_map(|d| m.on(*d).map(|p| branch_of(&u, &p)))
                                .collect();
                            let cells = days
                                .iter()
                                .filter_map(|d| {
                                    let p = m.on(*d)?;
                                    let entry = entries.remove(&(m.id, *d));
                                    Some(settings.for_entity(p.legal_entity_id).map(|thresholds| {
                                        let e = evaluate_day(
                                            &u,
                                            &p,
                                            *d,
                                            entry.as_ref(),
                                            &[],
                                            today,
                                            thresholds,
                                        );
                                        add(&mut totals, &e);
                                        grid_cell(*d, &e, entry.as_ref())
                                    }))
                                })
                                .collect::<Result<Vec<_>, _>>()?;
                            Ok(GridRow {
                                employee_id: m.id,
                                employee_number: m.number.clone(),
                                name: m.name.clone(),
                                unit_name: m
                                    .unit
                                    .and_then(|x| u.org.units.get(&x))
                                    .map(|x| x.name.clone()),
                                own: own == Some(m.id),
                                cells,
                                totals,
                                month_state: closes.state(first, &branches),
                            })
                        })
                        .collect::<Result<Vec<_>, ScheduleStoreError>>()?;
                    Ok(MonthGrid {
                        month: q.month,
                        rows,
                        people_total: total,
                        next_cursor,
                    })
                })
            },
        )
        .await
    }

    pub async fn person_month(
        &self,
        caller: &CallerScope,
        employee: Uuid,
        month: String,
    ) -> Result<PersonMonth, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let (first, last) = month_range(&month)?;
                    let today = today_kst();
                    let org = load_org(tx).await?;
                    let u = Universe::load(tx, org, (first.year(), first.year())).await?;
                    let m = load_members(tx, first, last, Some(&[employee]))
                        .await?
                        .pop()
                        .ok_or(ScheduleStoreError::NotFound(codes::SCOPE_NOT_FOUND))?;
                    let mut days = Vec::new();
                    let mut totals = GridTotals::default();
                    let mut branches = Vec::new();
                    let mut entries = current(tx, first, last, Some(&[employee])).await?;
                    let settings =
                        RecordSettings::load(tx, caller.org_id, m.setting_entities()).await?;
                    let mut d = first;
                    while d <= last {
                        if let Some(p) = m.on(d) {
                            if !visible(&caller, &u, &p) {
                                return Err(ScheduleStoreError::Forbidden);
                            }
                            branches.push(branch_of(&u, &p));
                            let entry = entries.remove(&(employee, d));
                            let e = evaluate_day(
                                &u,
                                &p,
                                d,
                                entry.as_ref(),
                                &[],
                                today,
                                settings.for_entity(p.legal_entity_id)?,
                            );
                            add(&mut totals, &e);
                            days.push(day_read(d, e, entry));
                        }
                        d += Duration::days(1);
                    }
                    let month_state = Closes::load(tx).await?.state(first, &branches);
                    let history = history(tx, employee, first, last)
                        .await?
                        .into_iter()
                        .map(|(date, entry)| HistoryRow { date, entry })
                        .collect();
                    Ok(PersonMonth {
                        employee_id: employee,
                        employee_number: m.number.clone(),
                        name: m.name.clone(),
                        month,
                        days,
                        history,
                        totals,
                        provisional: month_state.takes_writes(),
                        month_state,
                    })
                })
            },
        )
        .await
    }
}
