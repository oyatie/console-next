//! 일별 · 간단히 (A1-day): the partition ledger, then 사업장 › 부서 groups with
//! issue rows first and clean rows folded. Groups follow the chart's order
//! (사업장, then its 부서 in their stored 순서), never the name.

use std::collections::BTreeMap;

use console_attendance_application::CallerScope;
use console_attendance_application::records_read::{
    BoardGroup, BoardRow, DayBoard, Ledger, MarkCounts,
};
use console_attendance_domain::records::EntryKind;
use console_attendance_domain::schedule::DayKind;
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use time::Date;
use uuid::Uuid;

use super::day::{count, day_read, evaluate_day};
use super::entries::current;
use super::roster::{load_members, own_employee};
use super::thresholds::RecordSettings;
use crate::PgAttendanceStore;
use crate::schedule::org::{OrgModel, Person, load_org};
use crate::schedule::preview::{branch_of, visible};
use crate::schedule::universe::{Universe, today_kst};
use crate::schedule::{Closes, ScheduleStoreError};

#[derive(Debug, Clone, Default)]
pub struct BoardQuery {
    pub date: Option<Date>,
    pub workplace_id: Option<Uuid>,
    pub unit_id: Option<Uuid>,
    pub issues_only: bool,
    pub no_schedule_only: bool,
}

pub(crate) fn group_name(org: &OrgModel, p: &Person) -> String {
    let site = p
        .workplace_id
        .and_then(|w| org.workplaces.get(&w))
        .map(|w| w.name.clone())
        .unwrap_or_default();
    let mut path: Vec<String> = p
        .unit
        .map(|u| {
            org.chain(u)
                .iter()
                .rev()
                .filter_map(|(id, _)| org.units.get(id).map(|x| x.name.clone()))
                .collect()
        })
        .unwrap_or_default();
    path.insert(0, site);
    path.join(" › ")
}

fn classify(l: &mut Ledger, judged: bool, row: &BoardRow) {
    let d = &row.day;
    let work = d.plan.kind == DayKind::Work || d.plan.holiday_work;
    let kind = d
        .entry
        .as_ref()
        .map(|e| e.kind)
        .filter(|k| *k != EntryKind::Void);
    let slot = match (d.plan.kind, kind) {
        (DayKind::NoSchedule, _) => &mut l.no_schedule,
        (_, None) if !work => &mut l.rest,
        (_, None) if !judged => &mut l.pending,
        (_, None) => &mut l.no_record,
        (_, Some(EntryKind::ClockInOnly)) => &mut l.missing_out,
        (_, Some(EntryKind::Absent)) => &mut l.absent,
        (_, Some(EntryKind::OutsideWork)) => &mut l.outside,
        (_, Some(EntryKind::BusinessTrip)) => &mut l.trip,
        _ if d.recognition.late_in + d.recognition.early_out + d.recognition.away > 0 => {
            &mut l.late_or_early
        }
        _ => &mut l.normal,
    };
    *slot += 1;
    l.people += 1;
}

impl PgAttendanceStore {
    pub async fn day_board(
        &self,
        caller: &CallerScope,
        q: BoardQuery,
    ) -> Result<DayBoard, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let today = today_kst();
                    let date = q.date.unwrap_or(today - time::Duration::days(1));
                    let org = load_org(tx).await?;
                    let u = Universe::load(tx, org, (date.year(), date.year())).await?;
                    super::authorize_filters(&caller, &u, q.workplace_id, q.unit_id)?;
                    let own = own_employee(tx, caller.user_id).await?;
                    let members = load_members(tx, date, date, None).await?;
                    let people: Vec<Person> = members
                        .iter()
                        .filter_map(|m| m.on(date))
                        .filter(|p| {
                            visible(&caller, &u, p)
                                && q.workplace_id.is_none_or(|w| p.workplace_id == Some(w))
                                && (!q.no_schedule_only
                                    || q.unit_id.is_none_or(|unit| {
                                        p.unit.is_some_and(|id| {
                                            u.org.chain(id).iter().any(|(id, _)| *id == unit)
                                        })
                                    }))
                        })
                        .collect();
                    let ids: Vec<Uuid> = people.iter().map(|p| p.id).collect();
                    let settings = RecordSettings::load(
                        tx,
                        caller.org_id,
                        people.iter().map(|p| p.legal_entity_id),
                    )
                    .await?;
                    let mut entries = current(tx, date, date, Some(&ids)).await?;
                    let judged = date < today;
                    let closes = Closes::load(tx).await?;
                    let mut ledger = Ledger::default();
                    let mut marks = MarkCounts::default();
                    let rank = u.org.tree_rank();
                    let at = |id: Option<Uuid>| id.and_then(|x| rank.get(&x).copied());
                    // The 사업장's own group (no 부서) first, then its 부서 in the chart's order.
                    let mut groups: BTreeMap<
                        (usize, Option<usize>, String, Option<Uuid>),
                        BoardGroup,
                    > = BTreeMap::new();
                    for p in &people {
                        let entry = entries.remove(&(p.id, date));
                        let e = evaluate_day(
                            &u,
                            p,
                            date,
                            entry.as_ref(),
                            &[],
                            today,
                            settings.for_entity(p.legal_entity_id)?,
                        );
                        count(&mut marks, &e.marks);
                        let row = BoardRow {
                            employee_id: p.id,
                            employee_number: p.number.clone(),
                            name: p.name.clone(),
                            own: own == Some(p.id),
                            day: day_read(date, e, entry),
                            month_state: closes.state(date, &[branch_of(&u, p)]),
                        };
                        classify(&mut ledger, judged, &row);
                        let name = group_name(&u.org, p);
                        let g = groups
                            .entry((
                                at(p.workplace_id).unwrap_or(usize::MAX),
                                at(p.unit),
                                name.clone(),
                                p.unit,
                            ))
                            .or_insert_with(|| BoardGroup {
                                workplace_id: p.workplace_id,
                                unit_id: p.unit,
                                name,
                                people: 0,
                                normal: 0,
                                no_schedule: 0,
                                marks: MarkCounts::default(),
                                rows: Vec::new(),
                                hidden: 0,
                            });
                        g.people += 1;
                        g.no_schedule += i64::from(row.day.plan.kind == DayKind::NoSchedule);
                        count(&mut g.marks, &row.day.marks);
                        let open = q.unit_id.is_some() && q.unit_id == p.unit;
                        if row.day.marks.is_empty() {
                            g.normal += 1;
                        }
                        if open || !row.day.marks.is_empty() {
                            g.rows.push(row);
                        } else {
                            g.hidden += 1;
                        }
                    }
                    let mut groups: Vec<BoardGroup> = groups.into_values().collect();
                    if q.issues_only {
                        groups.retain(|g| g.marks.blocking + g.marks.decision + g.marks.info > 0);
                    }
                    for g in &mut groups {
                        if q.no_schedule_only {
                            g.rows.retain(|r| r.day.plan.kind == DayKind::NoSchedule);
                            g.hidden = 0;
                        }
                        g.rows.sort_by_key(|r| {
                            (
                                r.day.marks.is_empty(),
                                r.day.marks.iter().map(|m| m.tone()).min(),
                                r.employee_number.clone(),
                            )
                        });
                    }
                    if q.no_schedule_only {
                        groups.retain(|g| g.no_schedule > 0);
                    }
                    Ok(DayBoard {
                        date,
                        judged,
                        ledger,
                        marks,
                        groups,
                    })
                })
            },
        )
        .await
    }
}
