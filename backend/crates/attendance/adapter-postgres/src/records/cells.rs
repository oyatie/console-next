//! Typed cells judged against the roster, the 근무 일정, the current entry
//! (If-Match), closed months and the caller's own row. Preview, save, 정정
//! and 기록 취소 all decide here, so they answer alike.

use std::collections::{HashMap, HashSet};

use console_attendance_application::CallerScope;
use console_attendance_application::records::CellInput;
use console_attendance_application::records_read::{CellPreview, Conflict, EntryRead, MarkCounts};
use console_attendance_domain::records::{EntryKind, resolve_value};
use console_attendance_domain::schedule::Window;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::day::{count, day_read, evaluate_day};
use super::entries::current;
use super::roster::{load_members, own_employee};
use super::thresholds::RecordSettings;
use crate::schedule::org::load_org;
use crate::schedule::preview::{branch_of, visible};
use crate::schedule::universe::{Universe, today_kst};
use crate::schedule::{Closes, ScheduleStoreError, codes, lock_months};

pub(crate) enum Outcome {
    Write(EntryKind, Vec<Window>),
    Unchanged,
    Refused(&'static str),
    Conflict(Option<EntryRead>),
}

pub(crate) struct Judged {
    pub cell: CellInput,
    pub outcome: Outcome,
    pub preview: CellPreview,
    pub before: MarkCounts,
    pub after: MarkCounts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Judging {
    Preview,
    Save,
    /// 기록 취소: the value is ignored and the day goes empty.
    Void,
}

pub(crate) async fn judge(
    tx: &mut Transaction<'_, Postgres>,
    caller: &CallerScope,
    cells: Vec<CellInput>,
    mode: Judging,
) -> Result<Vec<Judged>, ScheduleStoreError> {
    let void = mode == Judging::Void;
    let today = today_kst();
    let (Some(first), Some(last)) = (
        cells.iter().map(|c| c.work_date).min(),
        cells.iter().map(|c| c.work_date).max(),
    ) else {
        return Ok(Vec::new());
    };
    let org = load_org(tx).await?;
    let u = Universe::load(tx, org, (first.year(), last.year())).await?;
    let own = own_employee(tx, caller.user_id).await?;
    let ids: Vec<Uuid> = cells
        .iter()
        .map(|c| c.employee_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let members: HashMap<Uuid, _> = load_members(tx, first, last, Some(&ids))
        .await?
        .into_iter()
        .map(|m| (m.id, m))
        .collect();
    let current = current(tx, first, last, Some(&ids)).await?;
    let settings = RecordSettings::load(
        tx,
        caller.org_id,
        members.values().flat_map(|m| m.setting_entities()),
    )
    .await?;
    let mut closes = if mode == Judging::Preview {
        Closes::load(tx).await?
    } else {
        lock_months(tx, caller.org_id, cells.iter().map(|c| c.work_date)).await?;
        Closes::load(tx).await?.metered()
    };
    let mut out = Vec::with_capacity(cells.len());
    for cell in cells {
        let (id, date) = (cell.employee_id, cell.work_date);
        let now = current.get(&(id, date));
        let refused = |code| (Outcome::Refused(code), None);
        let person = members.get(&id).and_then(|m| m.on(date));
        let mut long_span_minutes = None;
        let (outcome, after) = match &person {
            None => refused(codes::NOT_ON_ROSTER),
            Some(p) if !visible(caller, &u, p) => return Err(ScheduleStoreError::Forbidden),
            Some(_) if own == Some(id) => refused(codes::OWN_ROW),
            Some(p) if !closes.open_for(date, branch_of(&u, p)) => {
                refused(codes::ENTRY_MONTH_CLOSED)
            }
            Some(_) if now.map(|e| e.id) != cell.base_entry_id => {
                (Outcome::Conflict(now.cloned()), None)
            }
            Some(p) => {
                let threshold = settings.for_entity(p.legal_entity_id)?.long_span_minutes;
                long_span_minutes = Some(threshold);
                let refs = u.layers_for(p);
                let (_, plan) = u.day(p, &refs, date);
                let resolved = if void {
                    Ok((EntryKind::Void, Vec::new()))
                } else {
                    resolve_value(
                        &cell.value,
                        &plan,
                        date > today,
                        threshold,
                        cell.long_span_confirmed,
                    )
                };
                match resolved {
                    Err(r) => refused(r.code()),
                    Ok((kind, segments))
                        if now.is_some_and(|e| e.kind == kind && e.segments == segments) =>
                    {
                        (Outcome::Unchanged, None)
                    }
                    Ok((kind, segments)) => {
                        let draft = EntryRead {
                            id: Uuid::nil(),
                            batch_id: Uuid::nil(),
                            kind,
                            segments: segments.clone(),
                            source: String::new(),
                            evidence_kind: String::new(),
                            reason: None,
                            supersedes_id: None,
                            undone: false,
                            created_at: time::OffsetDateTime::UNIX_EPOCH,
                            created_by_name: String::new(),
                        };
                        let e = evaluate_day(
                            &u,
                            p,
                            date,
                            Some(&draft),
                            &[],
                            today,
                            settings.for_entity(p.legal_entity_id)?,
                        );
                        (Outcome::Write(kind, segments), Some((e, draft)))
                    }
                }
            }
        };
        let mut before = MarkCounts::default();
        let mut after_counts = MarkCounts::default();
        if let Some(p) = &person {
            count(
                &mut before,
                &evaluate_day(
                    &u,
                    p,
                    date,
                    now,
                    &[],
                    today,
                    settings.for_entity(p.legal_entity_id)?,
                )
                .marks,
            );
        }
        let (status, code) = match &outcome {
            Outcome::Write(..) => ("OK", None),
            Outcome::Unchanged => ("UNCHANGED", None),
            Outcome::Refused(c) => ("REFUSED", Some(*c)),
            Outcome::Conflict(_) => ("CONFLICT", Some(codes::ENTRY_CONFLICT)),
        };
        let after = after.map(|(e, draft)| {
            count(&mut after_counts, &e.marks);
            day_read(date, e, Some(draft))
        });
        if !matches!(outcome, Outcome::Write(..)) {
            after_counts = before;
        }
        out.push(Judged {
            preview: CellPreview {
                employee_id: id,
                work_date: date,
                long_span_minutes,
                status,
                code,
                after,
            },
            cell,
            outcome,
            before,
            after: after_counts,
        });
    }
    closes.report();
    Ok(out)
}

/// Marks a set of judged cells would close and open, by tone.
pub(crate) fn deltas(judged: &[Judged]) -> (MarkCounts, MarkCounts) {
    let (mut closes, mut opens) = (MarkCounts::default(), MarkCounts::default());
    for j in judged {
        closes.blocking += (j.before.blocking - j.after.blocking).max(0);
        closes.decision += (j.before.decision - j.after.decision).max(0);
        closes.info += (j.before.info - j.after.info).max(0);
        opens.blocking += (j.after.blocking - j.before.blocking).max(0);
        opens.decision += (j.after.decision - j.before.decision).max(0);
        opens.info += (j.after.info - j.before.info).max(0);
    }
    (closes, opens)
}

/// The refusal a save answers when any cell cannot be written as asked.
pub(crate) fn refusal_of(judged: &[Judged]) -> Option<ScheduleStoreError> {
    let conflicts: Vec<Conflict> = judged
        .iter()
        .filter_map(|j| match &j.outcome {
            Outcome::Conflict(current) => Some(Conflict {
                employee_id: j.cell.employee_id,
                work_date: j.cell.work_date,
                base_entry_id: j.cell.base_entry_id,
                current: current.clone(),
                mine: j.cell.value.clone(),
            }),
            _ => None,
        })
        .collect();
    if !conflicts.is_empty() {
        return Some(ScheduleStoreError::EntryConflict(conflicts));
    }
    let refused: Vec<CellPreview> = judged
        .iter()
        .filter(|j| matches!(j.outcome, Outcome::Refused(_)))
        .map(|j| j.preview.clone())
        .collect();
    (!refused.is_empty()).then_some(ScheduleStoreError::CellsRefused(refused))
}
