// SPDX-License-Identifier: LicenseRef-Proprietary
//! Dated §54① bands and the explicit-request waiver.

use time::Date;

use super::pattern::{Shift, Window};

/// One dated §54① band from the break-floor register.
///
/// A non-waiver row applies when worked minutes are at least `work_minutes`
/// and then requires `rest_minutes`. A waiver row applies only on its dates,
/// only when worked minutes equal `work_minutes`, and only when the worker
/// asked to skip the break. The numbers live on the row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BreakFloorRow {
    pub code: String,
    pub effective_from: Date,
    pub effective_to_exclusive: Option<Date>,
    pub work_minutes: u16,
    pub rest_minutes: u16,
    pub waiver: bool,
}

/// Which register row judged a shift, if any band was in force.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BreakFloorFinding<'a> {
    /// `governing` is the strictest band that applied. `None` means the worked
    /// length sits under every band in force.
    Within {
        governing: Option<&'a BreakFloorRow>,
    },
    Below {
        governing: &'a BreakFloorRow,
    },
    /// No register row covers `on`. Fail closed: do not guess a floor.
    NotInForce,
}

/// Minutes removed from a span.
///
/// Nothing recorded (`recorded == None`) uses the planned windows. A recording,
/// including an empty one, uses that recording. Minutes outside the span do
/// not count. The statutory floor is never inserted on top.
#[must_use]
pub(crate) fn deducted_break_minutes(
    span_start: u16,
    span_end: u16,
    planned: &[Window],
    recorded: Option<&[Window]>,
) -> u16 {
    let source = recorded.unwrap_or(planned);
    let total: u32 = source
        .iter()
        .map(|w| u32::from(overlap(span_start, span_end, w.start, w.end)))
        .sum();
    u16::try_from(total).unwrap_or(u16::MAX)
}

fn overlap(span_start: u16, span_end: u16, start: u16, end: u16) -> u16 {
    end.min(span_end).saturating_sub(start.max(span_start))
}

fn row_in_force(row: &BreakFloorRow, on: Date) -> bool {
    on >= row.effective_from && row.effective_to_exclusive.is_none_or(|end| on < end)
}

impl Shift {
    /// §54① against the register rows in force on `on`. `waiver_requested` is the
    /// worker's explicit ask to skip the break; without it the waiver row does
    /// not apply.
    #[must_use]
    pub(crate) fn judge_break<'a>(
        &self,
        on: Date,
        floors: &'a [BreakFloorRow],
        waiver_requested: bool,
    ) -> BreakFloorFinding<'a> {
        let active: Vec<&BreakFloorRow> = floors.iter().filter(|r| row_in_force(r, on)).collect();
        if active.is_empty() {
            return BreakFloorFinding::NotInForce;
        }
        let rest = deducted_break_minutes(self.start, self.end, &self.breaks, None);
        let work = self.minutes();
        if waiver_requested
            && let Some(waiver) = active
                .iter()
                .copied()
                .filter(|r| r.waiver && r.work_minutes == work)
                .max_by_key(|r| r.effective_from)
        {
            return if rest < waiver.rest_minutes {
                BreakFloorFinding::Below { governing: waiver }
            } else {
                BreakFloorFinding::Within {
                    governing: Some(waiver),
                }
            };
        }
        let applicable: Vec<&BreakFloorRow> = active
            .iter()
            .copied()
            .filter(|r| !r.waiver && work >= r.work_minutes)
            .collect();
        let Some(governing) = applicable.iter().copied().max_by_key(|r| r.work_minutes) else {
            return BreakFloorFinding::Within { governing: None };
        };
        if let Some(short) = applicable
            .iter()
            .copied()
            .filter(|r| rest < r.rest_minutes)
            .max_by_key(|r| (r.rest_minutes, r.work_minutes))
        {
            return BreakFloorFinding::Below { governing: short };
        }
        BreakFloorFinding::Within {
            governing: Some(governing),
        }
    }
}
