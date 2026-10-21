//! The entry grammar (spec A3): one table for typing, paste and import. The
//! console parses it for drafts; the server re-parses every value it saves.
//!   9-18 · 0900-1800 · 09:00~18:00 · 9:30-18:15 · 6:50-16 (H:MM-H)
//!   22-6+ (ends the next day) · 9-18/90 (90 minutes away in the middle)
//!   9-12,13:30-18 (외출 between spans) · 7:52- (출근만, 퇴근 누락)
//!   = or 소정 (the 근무 일정's shift) · x or 결근 · o or 외근 · 출장
//! Refused: +2 or 18+2 (연장 is only a 승인), unconfirmed policy-long spans, 22-6 without +.

use crate::schedule::Window;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Times(Vec<Window>),
    ClockInOnly(u16),
    AsScheduled,
    Absent,
    OutsideWork,
    BusinessTrip,
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
        }
    }
}

/// `9`, `09`, `9:30`, `09:30`, `0930` → minutes; 24:00 only as 1440.
fn clock(raw: &str) -> Option<u16> {
    let raw = raw.trim();
    let digits = |s: &str| !s.is_empty() && s.len() <= 2 && s.bytes().all(|b| b.is_ascii_digit());
    let (h, m) = match raw.split_once(':') {
        Some((h, m)) if digits(h) && m.len() == 2 && digits(m) => (h, m),
        None if raw.len() == 4 && raw.bytes().all(|b| b.is_ascii_digit()) => raw.split_at(2),
        None if digits(raw) => (raw, "0"),
        _ => return None,
    };
    let (h, m): (u16, u16) = (h.parse().ok()?, m.parse().ok()?);
    (m < 60 && h * 60 + m <= 1440).then_some(h * 60 + m)
}

fn bounds(raw: &str) -> Result<(u16, u16), ParseRefusal> {
    let (a, b) = raw.split_once(['-', '~']).ok_or(ParseRefusal::Unreadable)?;
    Ok((
        clock(a).ok_or(ParseRefusal::Unreadable)?,
        clock(b).ok_or(ParseRefusal::Unreadable)?,
    ))
}

/// # Errors
/// Why the value cannot be saved, with a stable code.
pub fn parse(raw: &str, long_span_minutes: u32, confirmed: bool) -> Result<Entry, ParseRefusal> {
    if raw.chars().take(41).count() > 40 {
        return Err(ParseRefusal::Unreadable);
    }
    let v = raw.trim();
    match v {
        "=" | "소정" => return Ok(Entry::AsScheduled),
        "x" | "X" | "결근" => return Ok(Entry::Absent),
        "o" | "O" | "외근" => return Ok(Entry::OutsideWork),
        "출장" => return Ok(Entry::BusinessTrip),
        "" => return Err(ParseRefusal::Unreadable),
        _ => {}
    }
    let (body, next_day) = v
        .strip_suffix('+')
        .map_or((v, false), |b| (b.trim_end(), true));
    if body.contains('+') {
        return Err(ParseRefusal::OvertimeTyped);
    }
    if let Some(start) = body.strip_suffix(['-', '~']) {
        return clock(start)
            .filter(|m| *m < 1440)
            .map(Entry::ClockInOnly)
            .ok_or(ParseRefusal::Unreadable);
    }
    let (body, away) = match body.split_once('/') {
        Some((b, m)) => (
            b,
            Some(
                m.trim()
                    .parse::<u16>()
                    .map_err(|_| ParseRefusal::Unreadable)?,
            ),
        ),
        None => (body, None),
    };
    let mut spans = Vec::new();
    let mut shift = 0u16;
    for part in body.split(',') {
        let (mut start, mut end) = bounds(part)?;
        start += shift;
        end += shift;
        let prev = spans.last().map(|w: &Window| w.end);
        if prev.is_some_and(|p| start < p) && next_day && shift == 0 {
            shift = 1440;
            start += 1440;
            end += 1440;
        }
        if end <= start {
            if !next_day || end >= 1440 {
                return Err(ParseRefusal::OvernightWithoutMarker);
            }
            end += 1440;
        }
        if start >= end || start >= 2880 || end > 2880 || (spans.is_empty() && start >= 1440) {
            return Err(ParseRefusal::Unreadable);
        }
        if spans.last().is_some_and(|w: &Window| start < w.end) {
            return Err(ParseRefusal::SpansOverlap);
        }
        spans.push(Window { start, end });
    }
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
