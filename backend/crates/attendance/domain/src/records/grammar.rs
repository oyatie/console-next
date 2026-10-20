//! The entry grammar (spec A3, input patterns §2.1): one table for typing,
//! paste and import. The console parses it for drafts; the server re-parses
//! every value it saves. Both run every case in
//! `scripts/fixtures/attendance-grammar-cases.json`.
//!   9-18 · 0900-1800 · 09:00~18:00 · 9:30-18:15 · 6:50-16 (H:MM-H) · 09.30-18
//!   9시-18시 · 오전 9-오후 6 · AM9-PM6 · full-width digits and any dash (9–18)
//!   22-6+ or 22-30 (ends the next day; 22-7 alone when the plan crosses midnight)
//!   9-18/90 or 9-18 휴1 · 휴60 · 휴1:30 (time away in the middle)
//!   9-12,13:30-18 (외출 between spans) · 7:52- (출근만) · -18 (퇴근만)
//!   = 소정 재택 교육 (the 근무 일정's shift) · x 결근 결 · o 외근 외 · 출장
//!   휴 휴무 OFF (day off) · D E N 주 야 비 당 S1 (shift codes) · 연차 반 병가 … (휴가):
//!   read here, resolved against the day's plan by `resolve_value`.
//! Refused: +2, 18+2 or 연장2 (연장 is only a 승인), 지각 · 조퇴 (derived),
//! 8 or 8:00 alone (hours, not times), 0.375 (an Excel fraction), 출 (출근 or
//! 출장?), unconfirmed policy-long spans, 22-6 without + off a night plan.

use crate::schedule::Window;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Times(Vec<Window>),
    ClockInOnly(u16),
    /// `-18`: 퇴근 only, 출근 missing.
    ClockOutOnly(u16),
    AsScheduled,
    Absent,
    OutsideWork,
    BusinessTrip,
    /// `휴` · `휴무` · `OFF`: a day off, which only the 근무 일정 makes.
    DayOff,
    /// `D` · `야` · `S1`: a shift code, read against the day's planned slot.
    Shift(String),
    /// `연차` · `반` · `병가` …: a leave word as typed; the tenant's leave types resolve it.
    Leave(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseRefusal {
    /// `+2`: a later 퇴근 never creates 연장 (the 승인 is recorded instead).
    OvertimeTyped,
    /// Not a time or a code; the console boxes the wrong character.
    Unreadable,
    /// Ends before it starts without the next-day `+`.
    OvernightWithoutMarker,
    /// Longer than the effective confirmation threshold without acknowledgement.
    SpanTooLong,
    /// Spans overlap or run backwards.
    SpansOverlap,
    /// `지각` · `조퇴`: derived from the times and the schedule, never typed.
    StatusIsDerived,
    /// `8` · `8:00` alone: hours worked or a clock time.
    HoursWithoutTimes,
    /// `0.375`: an Excel time fraction from a General-format cell.
    ExcelFraction,
    /// `출`: 출근 or 출장.
    CodeAmbiguous,
}

impl ParseRefusal {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::OvertimeTyped => "overtime_typed",
            Self::Unreadable => "entry_unreadable",
            Self::OvernightWithoutMarker => "overnight_without_marker",
            Self::SpanTooLong => "span_too_long",
            Self::SpansOverlap => "spans_overlap",
            Self::StatusIsDerived => "status_is_derived",
            Self::HoursWithoutTimes => "hours_without_times",
            Self::ExcelFraction => "excel_fraction",
            Self::CodeAmbiguous => "code_ambiguous",
        }
    }
}

fn digits(s: &str, len: std::ops::RangeInclusive<usize>) -> bool {
    len.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// NFKC, every dash as `-`, ECMAScript whitespace collapsed to ASCII spaces.
fn normalise(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.nfkc() {
        let c = match c {
            '~'
            | '\u{2010}'..='\u{2015}'
            | '\u{2053}'
            | '\u{2212}'
            | '\u{223C}'
            | '\u{301C}'
            | '\u{3030}'
            | '\u{FE58}'
            | '\u{FE63}' => '-',
            _ => c,
        };
        out.push(c);
    }
    // ECMAScript includes BOM but excludes NEL, unlike Rust's whitespace.
    out.split(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{0085}'))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// A whole-cell code word, or `None` for a time.
fn code(v: &str) -> Option<Result<Entry, ParseRefusal>> {
    let slot = v.strip_prefix(['S', 's']).is_some_and(|n| digits(n, 1..=2));
    Some(Ok(match v {
        "=" | "소정" | "재" | "재택" | "교육" => Entry::AsScheduled,
        "x" | "X" | "결근" | "결" => Entry::Absent,
        "o" | "O" | "외근" | "외" => Entry::OutsideWork,
        "출장" => Entry::BusinessTrip,
        "휴" | "휴무" | "OFF" | "Off" | "off" => Entry::DayOff,
        "D" | "E" | "N" | "d" | "e" | "n" => Entry::Shift(v.to_ascii_uppercase()),
        _ if slot => Entry::Shift(v.to_ascii_uppercase()),
        "주" | "야" | "비" | "당" => Entry::Shift(v.to_owned()),
        "v" | "V" | "휴가" | "연" | "연차" | "반" | "오전반차" | "오후반차" | "반반" | "병"
        | "병가" | "경조" | "공가" | "예비군" | "민방위" | "생리" | "무급" => {
            Entry::Leave(v.to_owned())
        }
        "출" => return Some(Err(ParseRefusal::CodeAmbiguous)),
        "지" | "지각" | "조" | "조퇴" => return Some(Err(ParseRefusal::StatusIsDerived)),
        _ if v.starts_with("연장") => return Some(Err(ParseRefusal::OvertimeTyped)),
        _ => return None,
    }))
}

/// `오전` · `오후` · `AM` · `PM` before a clock: whether it is the afternoon.
fn meridiem(raw: &str) -> (Option<bool>, &str) {
    if let Some(rest) = raw.strip_prefix("오전") {
        return (Some(false), rest.trim_start_matches(' '));
    }
    if let Some(rest) = raw.strip_prefix("오후") {
        return (Some(true), rest.trim_start_matches(' '));
    }
    match raw.get(..2) {
        Some(w) if w.eq_ignore_ascii_case("am") => (Some(false), raw[2..].trim_start_matches(' ')),
        Some(w) if w.eq_ignore_ascii_case("pm") => (Some(true), raw[2..].trim_start_matches(' ')),
        _ => (None, raw),
    }
}

/// `9`, `09`, `9:30`, `09.30`, `0930`, `9시`, with an optional 오전/오후 →
/// minutes; 24:00 only as 1440. A `late` end (no 오전/오후) may run to 47:59,
/// the next day in shift-sheet notation.
fn clock(raw: &str, late: bool) -> Option<u16> {
    let (half, raw) = meridiem(raw.trim_matches(' '));
    let (raw, whole) = raw
        .strip_suffix('시')
        .map_or((raw, false), |r| (r.trim_end_matches(' '), true));
    let (h, m) = match raw.split_once([':', '.']) {
        Some((h, m)) if !whole && digits(h, 1..=2) && digits(m, 2..=2) => (h, m),
        None if !whole && digits(raw, 4..=4) => raw.split_at(2),
        None if digits(raw, 1..=2) => (raw, "0"),
        _ => return None,
    };
    let (mut h, m): (u16, u16) = (h.parse().ok()?, m.parse().ok()?);
    if let Some(pm) = half {
        if !(1..=12).contains(&h) {
            return None;
        }
        h = h % 12 + if pm { 12 } else { 0 };
    }
    let t = h * 60 + m;
    (m < 60 && (t <= 1440 || (late && half.is_none() && t < 2880))).then_some(t)
}

/// `9-18 휴1`: the break word at the end — under 10 counts hours, else
/// minutes, or h:mm — split off, the next-day `+` kept on the body.
fn break_suffix(body: &str) -> Result<(String, Option<u16>), ParseRefusal> {
    let Some((head, tail)) = body.rsplit_once('휴') else {
        return Ok((body.to_owned(), None));
    };
    let tail = tail.trim_matches(' ');
    let (tail, plus) = tail
        .strip_suffix('+')
        .map_or((tail, ""), |t| (t.trim_end_matches(' '), "+"));
    let minutes = match tail.split_once(':') {
        Some((h, m)) if digits(h, 1..=2) && digits(m, 2..=2) => h
            .parse::<u16>()
            .ok()
            .zip(m.parse::<u16>().ok())
            .filter(|(_, m)| *m < 60)
            .map(|(h, m)| h * 60 + m),
        None if digits(tail, 1..=2) => tail
            .parse::<u16>()
            .ok()
            .map(|n| if n < 10 { n * 60 } else { n }),
        _ => None,
    };
    let minutes = minutes.ok_or(ParseRefusal::Unreadable)?;
    Ok((
        format!("{}{plus}", head.trim_end_matches(' ')),
        Some(minutes),
    ))
}

/// A value with no range: a fraction of a day or a count of hours.
fn alone(v: &str) -> Option<ParseRefusal> {
    let any = |s: &str| digits(s, 1..=usize::MAX);
    match v.split_once('.') {
        Some((h, f)) if (h.is_empty() || h == "0") && any(f) => Some(ParseRefusal::ExcelFraction),
        Some((h, f)) if digits(h, 1..=2) && any(f) => Some(ParseRefusal::HoursWithoutTimes),
        _ if clock(v, false).is_some() => Some(ParseRefusal::HoursWithoutTimes),
        _ => None,
    }
}

fn spans(body: &str, next_day: bool, overnight: bool) -> Result<Vec<Window>, ParseRefusal> {
    let parts: Vec<&str> = body.split(',').collect();
    let wrap = next_day || (overnight && parts.len() == 1);
    let mut spans = Vec::new();
    let mut shift = 0u16;
    for part in parts {
        let (a, b) = part.split_once('-').ok_or(ParseRefusal::Unreadable)?;
        let start = clock(a, false).ok_or(ParseRefusal::Unreadable)?;
        let end = clock(b, !next_day).ok_or(ParseRefusal::Unreadable)?;
        let (mut start, mut end) = (start + shift, end + shift);
        let prev = spans.last().map(|w: &Window| w.end);
        if prev.is_some_and(|p| start < p) && next_day && shift == 0 {
            shift = 1440;
            start += 1440;
            end += 1440;
        }
        if end <= start {
            if !wrap || end >= 1440 {
                return Err(ParseRefusal::OvernightWithoutMarker);
            }
            end += 1440;
        }
        if start >= end || start >= 2880 || end > 2880 || (spans.is_empty() && start >= 1440) {
            return Err(ParseRefusal::Unreadable);
        }
        if prev.is_some_and(|p| start < p) {
            return Err(ParseRefusal::SpansOverlap);
        }
        spans.push(Window { start, end });
    }
    Ok(spans)
}

/// # Errors
/// Why the value cannot be read, with a stable code. `overnight`: the day's
/// planned shift crosses midnight, so a single span may end the next day
/// without the `+`.
pub fn parse(
    raw: &str,
    long_span_minutes: u32,
    confirmed: bool,
    overnight: bool,
) -> Result<Entry, ParseRefusal> {
    if raw.chars().take(41).count() > 40 {
        return Err(ParseRefusal::Unreadable);
    }
    let v = normalise(raw);
    if let Some(read) = code(&v) {
        return read;
    }
    let v = ["재택", "교육"]
        .iter()
        .find_map(|w| v.strip_prefix(w))
        .map_or(v.as_str(), |s| s.trim_start_matches(' '));
    let (body, break_minutes) = break_suffix(v)?;
    let (body, next_day) = body
        .strip_suffix('+')
        .map_or((body.as_str(), false), |b| (b.trim_end_matches(' '), true));
    if body.contains('+') {
        return Err(ParseRefusal::OvertimeTyped);
    }
    if let Some(refusal) = alone(body) {
        return Err(refusal);
    }
    if let Some(end) = body.strip_prefix('-') {
        return clock(end, false)
            .filter(|m| *m > 0 && !next_day && break_minutes.is_none())
            .map(Entry::ClockOutOnly)
            .ok_or(ParseRefusal::Unreadable);
    }
    if let Some(start) = body.strip_suffix('-') {
        return clock(start, false)
            .filter(|m| *m < 1440 && break_minutes.is_none())
            .map(Entry::ClockInOnly)
            .ok_or(ParseRefusal::Unreadable);
    }
    let (body, away) = match body.split_once('/') {
        Some(_) if break_minutes.is_some() => return Err(ParseRefusal::Unreadable),
        Some((b, m)) => (
            b,
            Some(
                m.trim_matches(' ')
                    .parse::<u16>()
                    .map_err(|_| ParseRefusal::Unreadable)?,
            ),
        ),
        None => (body, break_minutes),
    };
    let spans = spans(body, next_day, overnight)?;
    let (first, last) = (spans[0].start, spans[spans.len() - 1].end);
    if u32::from(last - first) > long_span_minutes && !confirmed {
        return Err(ParseRefusal::SpanTooLong);
    }
    match (away, spans.as_slice()) {
        (Some(m), [one]) if m > 0 && m < (one.end - one.start).saturating_sub(1) => {
            let mid = one.start + (one.end - one.start - m) / 2;
            Ok(Entry::Times(vec![
                Window {
                    start: one.start,
                    end: mid,
                },
                Window {
                    start: mid + m,
                    end: one.end,
                },
            ]))
        }
        (Some(_), _) => Err(ParseRefusal::Unreadable),
        (None, _) => Ok(Entry::Times(spans)),
    }
}

#[cfg(test)]
#[path = "grammar_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "grammar_property_tests.rs"]
mod properties;
