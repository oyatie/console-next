//! 근태 기록 (ATT S2) read models: the day board (A1), the month grid (A3),
//! one person's month (A7), the save preview and receipt.

use console_attendance_domain::close::MonthState;
use console_attendance_domain::records::{EntryKind, Mark, Recognition};
use console_attendance_domain::schedule::{DayKind, Window};
use serde::Serialize;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::schedule::ShiftRead;

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

#[derive(Debug, Clone, Serialize)]
pub struct PlanRead {
    pub kind: DayKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift: Option<ShiftRead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holiday_name: Option<String>,
    pub holiday_work: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntryRead {
    pub id: Uuid,
    pub batch_id: Uuid,
    pub kind: EntryKind,
    pub segments: Vec<Window>,
    pub source: String,
    pub evidence_kind: String,
    pub reason: Option<String>,
    pub supersedes_id: Option<Uuid>,
    pub undone: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub created_by_name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct RecognitionRead {
    pub recorded: u32,
    pub recognised: u32,
    pub regular: u32,
    pub outside_scheduled: u32,
    pub prior_approved: u32,
    pub post_approved: u32,
    pub excess_open: u32,
    pub not_work: u32,
    pub over_cap: bool,
    /// Deprecated N-1 alias: prior_approved + post_approved.
    pub approved: u32,
    /// Deprecated N-1: paid early excess, awaiting disposition.
    pub early_unrecognised: u32,
    /// Deprecated N-1: paid late excess, awaiting disposition.
    pub late_unrecognised: u32,
    pub late_in: u32,
    pub early_out: u32,
    pub away: u32,
    pub approval_unused: u32,
}

impl From<Recognition> for RecognitionRead {
    fn from(r: Recognition) -> Self {
        Self {
            recorded: r.recorded,
            recognised: r.recognised,
            regular: r.regular,
            outside_scheduled: r.outside_scheduled,
            prior_approved: r.prior_approved,
            post_approved: r.post_approved,
            excess_open: r.excess_open,
            not_work: r.not_work,
            over_cap: r.over_cap,
            approved: r.approved,
            early_unrecognised: r.early_unrecognised,
            late_unrecognised: r.late_unrecognised,
            late_in: r.late_in,
            early_out: r.early_out,
            away: r.away,
            approval_unused: r.approval_unused,
        }
    }
}

/// One person-day in full (board rows, the day sheet, the person card).
#[derive(Debug, Clone, Serialize)]
pub struct DayRead {
    #[serde(with = "iso_date")]
    pub date: Date,
    pub plan: PlanRead,
    pub entry: Option<EntryRead>,
    pub recognition: RecognitionRead,
    pub marks: Vec<Mark>,
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct MarkCounts {
    pub blocking: i64,
    pub decision: i64,
    pub info: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardRow {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub name: String,
    pub own: bool,
    pub day: DayRead,
    /// Whether this person's day takes writes (see [`GridRow::month_state`]).
    pub month_state: MonthState,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoardGroup {
    pub workplace_id: Option<Uuid>,
    pub unit_id: Option<Uuid>,
    /// 사업장 › 부서 path.
    pub name: String,
    pub people: i64,
    pub normal: i64,
    pub no_schedule: i64,
    pub marks: MarkCounts,
    /// Issue rows first; clean rows only when the group is opened.
    pub rows: Vec<BoardRow>,
    pub hidden: i64,
}

/// The day's partition (G8): every person in scope lands in exactly one.
#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct Ledger {
    pub people: i64,
    pub no_schedule: i64,
    pub rest: i64,
    pub no_record: i64,
    pub missing_out: i64,
    pub absent: i64,
    pub outside: i64,
    pub trip: i64,
    pub late_or_early: i64,
    pub normal: i64,
    pub pending: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DayBoard {
    #[serde(with = "iso_date")]
    pub date: Date,
    /// The day is over (KST), so it is judged.
    pub judged: bool,
    pub ledger: Ledger,
    pub marks: MarkCounts,
    pub groups: Vec<BoardGroup>,
}

/// A grid cell: what the 월간 근무표 draws; the full day is one read away.
#[derive(Debug, Clone, Serialize)]
pub struct GridCell {
    #[serde(with = "iso_date")]
    pub date: Date,
    pub plan_kind: DayKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_kind: Option<EntryKind>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<Window>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub recognised: u32,
    pub unrecognised: u32,
    pub not_worked: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub marks: Vec<Mark>,
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct GridTotals {
    /// 인정 합계.
    pub recognised: u32,
    pub outside_scheduled: u32,
    /// Deprecated N-1: approved classification, never the pay gate.
    pub approved: u32,
    /// Deprecated N-1: paid open excess, awaiting disposition.
    pub unrecognised: u32,
    /// 미근로.
    pub not_worked: u32,
    /// 미해결 ▲ / ◆.
    pub blocking: i64,
    pub decision: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GridRow {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub name: String,
    pub unit_name: Option<String>,
    pub own: bool,
    pub cells: Vec<GridCell>,
    pub totals: GridTotals,
    /// Whether this person's month takes writes: closed, or reopened by an
    /// approved period unlock until it re-locks.
    pub month_state: MonthState,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonthGrid {
    pub month: String,
    pub rows: Vec<GridRow>,
    pub people_total: i64,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersonMonth {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub name: String,
    pub month: String,
    pub days: Vec<DayRead>,
    /// Every entry of the month, newest first (원천 · 이력).
    pub history: Vec<HistoryRow>,
    pub totals: GridTotals,
    /// The month is not closed, or reopened: the numbers are 잠정.
    pub provisional: bool,
    pub month_state: MonthState,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryRow {
    #[serde(with = "iso_date")]
    pub date: Date,
    pub entry: EntryRead,
}

#[derive(Debug, Clone, Serialize)]
pub struct CellPreview {
    pub employee_id: Uuid,
    #[serde(with = "iso_date")]
    pub work_date: Date,
    /// Effective employer policy, resolved by the server for this cell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_span_minutes: Option<u32>,
    /// OK · UNCHANGED · REFUSED · CONFLICT.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<DayRead>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SavePreview {
    pub cells: Vec<CellPreview>,
    pub ok: i64,
    pub unchanged: i64,
    pub refused: i64,
    pub conflicts: i64,
    /// Marks the save would clear and open, by tone.
    pub closes: MarkCounts,
    pub opens: MarkCounts,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaveReceipt {
    pub batch_id: Uuid,
    pub saved: i64,
    pub unchanged: i64,
    pub closes: MarkCounts,
    pub opens: MarkCounts,
}

#[derive(Debug, Clone, Serialize)]
pub struct Conflict {
    pub employee_id: Uuid,
    #[serde(with = "iso_date")]
    pub work_date: Date,
    pub base_entry_id: Option<Uuid>,
    pub current: Option<EntryRead>,
    pub mine: String,
}
