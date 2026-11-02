//! 일별 · 간단히 (A1-day): the partition ledger, then 사업장 › 부서 groups with
//! issue rows first and clean rows folded. Groups follow the chart's order
//! (사업장, then its 부서 in their stored 순서), never the name.

use std::{collections::BTreeMap, future::Future, pin::Pin};

use console_attendance_application::CallerScope;
use console_attendance_application::records_read::{
    BoardGroup, BoardRow, DayBoard, IssueGroup, Ledger, MarkCounts,
};
use console_attendance_domain::records::{EntryKind, Mark};
use console_attendance_domain::schedule::{DayKind, Level};
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;
use sqlx::{Postgres, Transaction};
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
    pub all_rows: bool,
    pub mark: Option<Mark>,
    pub cursor: Option<Uuid>,
    pub limit: Option<usize>,
}

/// Authorization port: the REST face loads Cedar facts inside this read transaction.
pub enum BoardReadTarget {
    Scope(Level, Uuid),
    Person { workplace: Option<Uuid> },
}
pub type BoardReadAccess =
    Box<dyn Fn(BoardReadTarget) -> Result<bool, ScheduleStoreError> + Send + Sync>;
pub type BoardAccessFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<BoardReadAccess>, ScheduleStoreError>> + Send + 'a>>;

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
        self.day_board_with_access(caller, q, |_| Box::pin(async { Ok(None) }))
            .await
    }

    pub async fn day_board_with_access<F>(
        &self,
        caller: &CallerScope,
        q: BoardQuery,
        load_access: F,
    ) -> Result<DayBoard, ScheduleStoreError>
    where
        F: for<'a> FnOnce(&'a mut Transaction<'_, Postgres>) -> BoardAccessFuture<'a>
            + Send
            + 'static,
    {
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
                    let access = load_access(tx).await?;
                    if let Some(access) = &access {
                        for (kind, id) in [
                            (Level::Workplace, q.workplace_id),
                            (Level::Department, q.unit_id),
                        ] {
                            if let Some(id) = id {
                                let workplace = match kind {
                                    Level::Workplace => {
                                        u.org.workplaces.contains_key(&id).then_some(id)
                                    }
                                    Level::Department => u.org.workplace_of_unit(id),
                                    _ => None,
                                }
                                .ok_or(
                                    ScheduleStoreError::NotFound(
                                        crate::schedule::codes::SCOPE_NOT_FOUND,
                                    ),
                                )?;
                                if !access(BoardReadTarget::Scope(Level::Workplace, workplace))? {
                                    return Err(ScheduleStoreError::Forbidden);
                                }
                            }
                        }
                    } else {
                        super::authorize_filters(&caller, &u, q.workplace_id, q.unit_id)?;
                    }
                    let own = own_employee(tx, caller.user_id).await?;
                    let first = date
                        .replace_day(1)
                        .map_err(|_| ScheduleStoreError::Corrupt("board month"))?;
                    let members = load_members(tx, first, date, None).await?;
                    let permitted = |p: &Person| -> Result<bool, ScheduleStoreError> {
                        if !(q.workplace_id.is_none_or(|w| p.workplace_id == Some(w))
                            && (!q.no_schedule_only
                                || q.unit_id.is_none_or(|unit| {
                                    p.unit.is_some_and(|id| {
                                        u.org.chain(id).iter().any(|(id, _)| *id == unit)
                                    })
                                })))
                        {
                            return Ok(false);
                        }
                        if let Some(access) = &access {
                            access(BoardReadTarget::Person {
                                workplace: p.workplace_id,
                            })
                        } else {
                            Ok(visible(&caller, &u, p))
                        }
                    };
                    let mut people = Vec::new();
                    for p in members.iter().filter_map(|m| m.on(date)) {
                        if permitted(&p)? {
                            people.push(p);
                        }
                    }
                    let ids: Vec<Uuid> = members.iter().map(|m| m.id).collect();
                    let settings = RecordSettings::load(
                        tx,
                        caller.org_id,
                        members.iter().flat_map(|m| m.setting_entities()),
                    )
                    .await?;
                    let mut entries = current(tx, first, date, Some(&ids)).await?;
                    let judged = date < today;
                    let closes = Closes::load(tx).await?;
                    let mut ledger = Ledger::default();
                    let mut marks = MarkCounts::default();
                    let mut issues = BTreeMap::<Mark, IssueGroup>::new();
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
                        for mark in &e.marks {
                            issues
                                .entry(*mark)
                                .or_insert(IssueGroup {
                                    kind: *mark,
                                    count: 0,
                                    earliest_date: date,
                                })
                                .count += 1;
                        }
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
                        if (q.all_rows && !q.issues_only) || open || !row.day.marks.is_empty() {
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
                    let next_cursor = super::board_page::page(&mut groups, &q);
                    super::board_issues::earliest(
                        &u,
                        &settings,
                        &members,
                        &entries,
                        today,
                        permitted,
                        &mut issues,
                    )?;
                    Ok(DayBoard {
                        date,
                        judged,
                        ledger,
                        marks,
                        issue_groups: issues.into_values().collect(),
                        next_cursor,
                        groups,
                    })
                })
            },
        )
        .await
    }
}
