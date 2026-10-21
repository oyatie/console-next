//! One person-day evaluated: plan from the 근무 일정, the current entry, the
//! recognition and the marks. Every read and the save preview share it.

use console_attendance_application::records_read::{
    DayRead, EntryRead, GridCell, GridTotals, MarkCounts, PlanRead, RecognitionRead,
};
use console_attendance_domain::records::{EntryKind, Mark, Thresholds, Tone, evaluate, marks};
use console_attendance_domain::schedule::{DayPlan, Window};
use time::Date;

use crate::schedule::org::Person;
use crate::schedule::read::shift_read;
use crate::schedule::universe::Universe;

pub(crate) struct Evaluated {
    pub plan: DayPlan,
    pub recognition: RecognitionRead,
    pub marks: Vec<Mark>,
}

/// `approved` are the day's 승인 windows (S3; empty until then).
pub(crate) fn evaluate_day(
    u: &Universe,
    p: &Person,
    date: Date,
    entry: Option<&EntryRead>,
    approved: &[Window],
    today: Date,
    thresholds: Thresholds,
) -> Evaluated {
    let refs = u.layers_for(p);
    let (_, plan) = u.day(p, &refs, date);
    let (kind, segments) = match entry {
        Some(e) if e.kind != EntryKind::Void => (Some(e.kind), e.segments.as_slice()),
        _ => (None, &[][..]),
    };
    let (recorded, rec) = evaluate(&plan, kind, segments, approved);
    let marks = marks(
        plan.kind,
        plan.holiday_work,
        recorded,
        &rec,
        date < today,
        thresholds,
    );
    Evaluated {
        plan,
        recognition: rec.into(),
        marks,
    }
}

pub(crate) fn plan_read(plan: &DayPlan) -> PlanRead {
    PlanRead {
        kind: plan.kind,
        shift: plan.shift.as_ref().map(shift_read),
        holiday_name: plan.holiday_name.clone(),
        holiday_work: plan.holiday_work,
    }
}

pub(crate) fn day_read(date: Date, e: Evaluated, entry: Option<EntryRead>) -> DayRead {
    DayRead {
        date,
        plan: plan_read(&e.plan),
        entry,
        recognition: e.recognition,
        marks: e.marks,
    }
}

pub(crate) fn grid_cell(date: Date, e: &Evaluated, entry: Option<&EntryRead>) -> GridCell {
    let live = entry.filter(|x| x.kind != EntryKind::Void);
    let r = e.recognition;
    GridCell {
        date,
        plan_kind: e.plan.kind,
        entry_id: entry.map(|x| x.id),
        entry_kind: live.map(|x| x.kind),
        segments: live.map(|x| x.segments.clone()).unwrap_or_default(),
        source: live.map(|x| x.source.clone()),
        recognised: r.recognised,
        unrecognised: r.early_unrecognised + r.late_unrecognised,
        not_worked: r.late_in + r.early_out + r.away,
        marks: e.marks.clone(),
    }
}

pub(crate) fn count(counts: &mut MarkCounts, marks: &[Mark]) {
    for m in marks {
        match m.tone() {
            Tone::Blocking => counts.blocking += 1,
            Tone::Decision => counts.decision += 1,
            Tone::Info => counts.info += 1,
        }
    }
}

pub(crate) fn add(t: &mut GridTotals, e: &Evaluated) {
    let r = e.recognition;
    t.recognised += r.recognised;
    t.approved += r.approved;
    t.unrecognised += r.early_unrecognised + r.late_unrecognised;
    t.not_worked += r.late_in + r.early_out + r.away;
    for m in &e.marks {
        match m.tone() {
            Tone::Blocking => t.blocking += 1,
            Tone::Decision => t.decision += 1,
            Tone::Info => {}
        }
    }
}
