//! Recorded work is paid after scheduled breaks and confirmed non-work.
//! Approvals classify worked minutes; they never gate recognition.

use crate::schedule::{DayKind, Shift, Window};
use serde::Serialize;

const SPAN: usize = 2880;
const WORDS: usize = SPAN / 64;

/// A set of minutes of one work date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Minutes([u64; WORDS]);

// std derives Default for arrays only up to 32 elements.
impl Default for Minutes {
    fn default() -> Self {
        Self([0; WORDS])
    }
}

impl Minutes {
    #[must_use]
    pub fn window(w: Window) -> Self {
        let mut m = Self::default();
        for i in usize::from(w.start)..usize::from(w.end).min(SPAN) {
            m.0[i / 64] |= 1 << (i % 64);
        }
        m
    }
    #[must_use]
    pub fn of(windows: &[Window]) -> Self {
        windows
            .iter()
            .fold(Self::default(), |a, w| a.or(Self::window(*w)))
    }
    #[must_use]
    pub fn or(self, o: Self) -> Self {
        let mut r = self;
        for (a, b) in r.0.iter_mut().zip(o.0) {
            *a |= b;
        }
        r
    }
    #[must_use]
    pub fn and(self, o: Self) -> Self {
        let mut r = self;
        for (a, b) in r.0.iter_mut().zip(o.0) {
            *a &= b;
        }
        r
    }
    #[must_use]
    pub fn minus(self, o: Self) -> Self {
        let mut r = self;
        for (a, b) in r.0.iter_mut().zip(o.0) {
            *a &= !b;
        }
        r
    }
    #[must_use]
    pub fn count(self) -> u32 {
        self.0.iter().map(|w| w.count_ones()).sum()
    }
    fn contains(self, minute: u16) -> bool {
        let minute = usize::from(minute);
        minute < SPAN && self.0[minute / 64] & (1 << (minute % 64)) != 0
    }
    /// Minutes before `at` / from `at` on.
    #[must_use]
    pub fn before(self, at: u16) -> Self {
        self.and(Self::window(Window { start: 0, end: at }))
    }
    #[must_use]
    pub fn after(self, at: u16) -> Self {
        self.and(Self::window(Window {
            start: at,
            end: 2880,
        }))
    }
}

/// Scheduled work: the shift span without its breaks.
#[must_use]
pub fn scheduled(shift: &Shift) -> Minutes {
    Minutes::window(Window {
        start: shift.start,
        end: shift.end,
    })
    .minus(Minutes::of(&shift.breaks))
}

pub const RECOGNITION_RULE_VERSION: &str = "ATTENDANCE_RECOGNITION_V1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IntervalCategory {
    Work,
    Break,
    Wait,
    Overtime,
    Night,
    Holiday,
    NotWork,
    Disputed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IntervalReason {
    ScheduledWork,
    ScheduledBreak,
    PriorApprovedOvertime,
    PostApprovedOvertime,
    OpenOvertime,
    HolidayWork,
    ConfirmedNotWork,
    ScheduleMissing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RecognitionInterval {
    pub start: u16,
    pub end: u16,
    pub minutes: u32,
    pub category: IntervalCategory,
    pub recognised: bool,
    pub reason_code: IntervalReason,
    pub rule_version: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Recognition {
    pub recorded: u32,
    pub recognised: u32,
    /// Recognised inside the contractual hours.
    pub regular: u32,
    pub outside_scheduled: u32,
    pub prior_approved: u32,
    pub post_approved: u32,
    pub excess_open: u32,
    pub not_work: u32,
    /// Set by the weekly statutory-cap evaluation; never reduces pay.
    pub over_cap: bool,
    /// Deprecated N-1 alias: prior_approved + post_approved.
    pub approved: u32,
    /// Deprecated N-1: early open excess; these minutes are paid.
    pub early_unrecognised: u32,
    /// Deprecated N-1: late open excess; these minutes are paid.
    pub late_unrecognised: u32,
    /// Contractual minutes not worked: late arrival · early leave · away.
    pub late_in: u32,
    pub early_out: u32,
    pub away: u32,
    pub approval_unused: u32,
    pub intervals: Vec<RecognitionInterval>,
}

fn intervals(
    recorded: &[Window],
    shift: Option<&Shift>,
    day: DayKind,
    prior_windows: &[Window],
    post_windows: &[Window],
    not_work_windows: &[Window],
) -> Vec<RecognitionInterval> {
    use IntervalCategory as C;
    use IntervalReason as R;

    let r = Minutes::of(recorded);
    if r.count() == 0 {
        return Vec::new();
    }
    let prior = Minutes::of(prior_windows);
    let post = Minutes::of(post_windows);
    let scheduled = shift
        .filter(|_| day == DayKind::Work)
        .map(scheduled)
        .unwrap_or_default();
    let breaks = shift.map(|x| Minutes::of(&x.breaks)).unwrap_or_default();
    let excluded = r.minus(breaks).and(Minutes::of(not_work_windows));
    let mut out: Vec<RecognitionInterval> = Vec::new();
    for start in 0..SPAN as u16 {
        if !r.contains(start) {
            continue;
        }
        let (category, reason) = if breaks.contains(start) {
            (C::Break, R::ScheduledBreak)
        } else if excluded.contains(start) {
            (C::NotWork, R::ConfirmedNotWork)
        } else if day == DayKind::NoSchedule {
            (C::Disputed, R::ScheduleMissing)
        } else if day != DayKind::Work {
            (C::Holiday, R::HolidayWork)
        } else if scheduled.contains(start) {
            (C::Work, R::ScheduledWork)
        } else if prior.contains(start) {
            (C::Overtime, R::PriorApprovedOvertime)
        } else if post.contains(start) {
            (C::Overtime, R::PostApprovedOvertime)
        } else {
            (C::Overtime, R::OpenOvertime)
        };
        if let Some(last) = out.last_mut()
            && last.end == start
            && last.category == category
            && last.reason_code == reason
        {
            last.end += 1;
            last.minutes += 1;
        } else {
            out.push(RecognitionInterval::new(start, start + 1, category, reason));
        }
    }
    out
}

/// Confirmed `not_work` windows exclude presence without work. Prior approval
/// takes precedence over post approval where their windows overlap.
#[must_use]
pub fn recognise(
    recorded: &[Window],
    shift: Option<&Shift>,
    day: DayKind,
    prior_approved: &[Window],
    post_approved: &[Window],
    not_work: &[Window],
) -> Recognition {
    let shift = shift.filter(|_| day != DayKind::NoSchedule);
    let r = Minutes::of(recorded);
    let prior = Minutes::of(prior_approved);
    let post = Minutes::of(post_approved);
    let a = prior.or(post);
    let s = shift
        .filter(|_| day == DayKind::Work)
        .map(scheduled)
        .unwrap_or_default();
    let breaks = shift.map(|x| Minutes::of(&x.breaks)).unwrap_or_default();
    let excluded = r.minus(breaks).and(Minutes::of(not_work));
    let recognised = r.minus(breaks).minus(excluded);
    // A missing plan leaves paid time unclassified until a schedule is assigned.
    let outside = if day == DayKind::NoSchedule {
        Minutes::default()
    } else {
        recognised.minus(s)
    };
    let open = outside.minus(a);
    let missing = s.minus(recognised);
    let (start, end) = shift
        .filter(|_| day == DayKind::Work)
        .map_or((0, 0), |x| (x.start, x.end));
    let worked = recognised.and(s);
    let first = worked
        .0
        .iter()
        .enumerate()
        .find_map(|(i, w)| (*w != 0).then(|| i * 64 + w.trailing_zeros() as usize));
    let last = worked
        .0
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, w)| (*w != 0).then(|| i * 64 + 63 - w.leading_zeros() as usize));
    let (late_in, early_out, away) = match (first, last) {
        (Some(f), Some(l)) => {
            let f = u16::try_from(f).unwrap_or(start);
            let l = u16::try_from(l + 1).unwrap_or(end);
            let li = missing.before(f).count();
            let eo = missing.after(l).count();
            (li, eo, missing.count() - li - eo)
        }
        _ => (0, 0, missing.count()),
    };
    Recognition {
        recorded: r.count(),
        recognised: recognised.count(),
        regular: recognised.and(s).count(),
        outside_scheduled: outside.count(),
        prior_approved: outside.and(prior).count(),
        post_approved: outside.and(post).minus(prior).count(),
        excess_open: open.count(),
        not_work: excluded.count(),
        // shortcut: slice 3 supplies the weekly cap flag; pay never depends on it.
        over_cap: false,
        approved: outside.and(a).count(),
        early_unrecognised: open.before(start).count(),
        late_unrecognised: open.after(end.max(start)).count(),
        late_in,
        early_out,
        away,
        approval_unused: a.minus(s).minus(breaks).minus(recognised).count(),
        intervals: intervals(
            recorded,
            shift,
            day,
            prior_approved,
            post_approved,
            not_work,
        ),
    }
}

#[cfg(test)]
#[path = "recognise_tests.rs"]
mod tests;
