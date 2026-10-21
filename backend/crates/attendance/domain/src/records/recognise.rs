//! The owner rule as one pure function (decision #22, AT §4.4a):
//! 인정 = 기록 ∩ (소정 ∪ 승인). Early arrival and late stays stay 기록 only;
//! they never become 연장. Minutes are from 00:00 of the work date (0..2880).

use crate::schedule::{Shift, Window};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Recognition {
    pub recorded: u32,
    pub recognised: u32,
    /// Recognised inside 소정.
    pub regular: u32,
    /// Recognised only through a 승인 window.
    pub approved: u32,
    pub early_unrecognised: u32,
    pub late_unrecognised: u32,
    /// 소정 minutes not worked: 지각 · 조퇴 · 이탈.
    pub late_in: u32,
    pub early_out: u32,
    pub away: u32,
    pub approval_unused: u32,
}

/// `approved` are the 승인 windows of the day, already without their breaks.
#[must_use]
pub fn recognise(recorded: &[Window], shift: Option<&Shift>, approved: &[Window]) -> Recognition {
    let r = Minutes::of(recorded);
    let a = Minutes::of(approved);
    let s = shift.map(scheduled).unwrap_or_default();
    let recognised = r.and(s.or(a));
    let outside = r
        .minus(s.or(a))
        .minus(shift.map(|x| Minutes::of(&x.breaks)).unwrap_or_default());
    let missing = s.minus(r);
    let (start, end) = shift.map_or((0, 0), |x| (x.start, x.end));
    let worked = r.and(s);
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
        regular: r.and(s).count(),
        approved: r.and(a).minus(s).count(),
        early_unrecognised: outside.before(start).count(),
        late_unrecognised: outside.after(end.max(start)).count(),
        late_in,
        early_out,
        away,
        approval_unused: a.minus(s).minus(r).count(),
    }
}

#[cfg(test)]
#[path = "recognise_tests.rs"]
mod tests;
