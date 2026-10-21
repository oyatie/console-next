//! BW-10 typed cells: a spreadsheet date and a person's name as the import
//! compares them. Pure; the dry run turns a `None` date into a per-row refusal.

use time::{Date, Duration, Month};

/// A date cell as Korean HR workbooks write it: `2024-03-04`, `2024.03.04`,
/// `2024/3/4`, `2024. 3. 4.`, `20240304`, `2024년 3월 4일` (W05), a trailing
/// time (`… 00:00:00`), or an Excel serial day number (what a date-formatted
/// cell reads as). Full-width digits read as digits. `None` for anything
/// else (a two-digit year included); never a guess.
#[must_use]
pub fn parse_import_date(raw: &str) -> Option<Date> {
    let text = half_width(raw.trim());
    // `2024년 3월 4일` → `2024.3.4`: only with all three markers, in order.
    let text = match korean_ymd(&text) {
        Some(dotted) => dotted,
        None => text,
    };
    let text = text.as_str();
    let text = text.split_once([' ', 'T']).map_or(text, |(day, rest)| {
        // `2024. 3. 4.` keeps its spaces; only a time part is cut.
        if rest.contains(':') { day } else { text }
    });
    if let Some(date) = excel_serial(text) {
        return Some(date);
    }
    if text.len() == 8 && text.bytes().all(|b| b.is_ascii_digit()) {
        return ymd(&text[..4], &text[4..6], &text[6..]);
    }
    let parts: Vec<&str> = text
        .split(['-', '.', '/'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    match parts.as_slice() {
        [y, m, d] if y.len() == 4 && m.len() <= 2 && d.len() <= 2 => ymd(y, m, d),
        _ => None,
    }
}

/// Full-width ASCII (U+FF01..U+FF5E) and the ideographic space as their
/// half-width forms, so `２０１１` reads as `2011`.
#[must_use]
pub fn half_width(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(u32::from(c) - 0xFEE0).unwrap_or(c),
            '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

/// `YYYY년 M월 D일` (any spacing, an optional trailing `.`) as `YYYY.M.D`.
fn korean_ymd(text: &str) -> Option<String> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let compact = compact.strip_suffix('.').unwrap_or(&compact);
    let (y, rest) = compact.split_once('년')?;
    let (m, rest) = rest.split_once('월')?;
    let d = rest.strip_suffix('일')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (y.len() == 4 && digits(y) && digits(m) && digits(d)).then(|| format!("{y}.{m}.{d}"))
}

fn ymd(y: &str, m: &str, d: &str) -> Option<Date> {
    // `str::parse` takes a sign (`"+3"`): only digits are a date part.
    if ![y, m, d]
        .iter()
        .all(|p| p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let month = Month::try_from(m.parse::<u8>().ok()?).ok()?;
    Date::from_calendar_date(y.parse().ok()?, month, d.parse().ok()?).ok()
}

/// Excel's day 1 is 1900-01-01 counted from 1899-12-30 (the 1900 leap-year
/// bug); only whole numbers from 1900-03-01 (61) to 9999-12-31 count.
fn excel_serial(text: &str) -> Option<Date> {
    let days: f64 = text.parse().ok()?;
    if days.fract() != 0.0 || !(61.0..=2_958_465.0).contains(&days) {
        return None;
    }
    let epoch = Date::from_calendar_date(1899, Month::December, 30).ok()?;
    #[allow(clippy::cast_possible_truncation)]
    epoch.checked_add(Duration::days(days as i64))
}

/// A name as identity compares it: whitespace removed (`김 등록` = `김등록`).
#[must_use]
pub fn name_key(name: &str) -> String {
    name.chars().filter(|c| !c.is_whitespace()).collect()
}

#[cfg(test)]
#[path = "cells_properties.rs"]
mod properties;

#[cfg(test)]
mod tests {
    use super::*;

    fn day(y: i32, m: u8, d: u8) -> Option<Date> {
        Date::from_calendar_date(y, Month::try_from(m).unwrap(), d).ok()
    }

    #[test]
    fn workbook_date_spellings_parse_to_one_day() {
        for raw in [
            "2024-03-04",
            "2024.03.04",
            "2024/3/4",
            "2024. 3. 4.",
            "20240304",
            "2024-03-04 00:00:00",
            "45355",
        ] {
            assert_eq!(parse_import_date(raw), day(2024, 3, 4), "{raw}");
        }
    }

    #[test]
    fn anything_else_is_not_a_date() {
        for raw in [
            "",
            "24-03-04",
            "2024-13-01",
            "2024-02-30",
            "45355.5",
            "3/4/2024",
            "입사일",
            // W05: Korean words with a bad day, a two-digit year, a missing marker.
            "2011년 2월 30일",
            "11년 4월 10일",
            "2011년 4월",
            "4월 10일 2011년",
            "2011년 4월 10",
            // A sign is not a digit (`str::parse` would take `+3`).
            "2024.+3.4",
            "2024-03-+4",
        ] {
            assert_eq!(parse_import_date(raw), None, "{raw}");
        }
    }

    /// regression (W05): the walkthrough's 75 rows of 「2011년 4월 10일」 were
    /// refused `invalid_date`; full-width digits likewise.
    #[test]
    fn regression_korean_word_dates_parse() {
        for raw in [
            "2011년 4월 10일",
            "2011년4월10일",
            "2011 년 04 월 10 일",
            "2011년 4월 10일.",
            "２０１１년 ４월 １０일",
            "２０１１.４.１０",
            "2011.4.10",
        ] {
            assert_eq!(parse_import_date(raw), day(2011, 4, 10), "{raw}");
        }
    }

    /// regression: `"+3"` parsed as month 3.
    #[test]
    fn regression_signed_date_parts_are_refused() {
        assert_eq!(parse_import_date("2024.+3.4"), None);
    }

    #[test]
    fn names_compare_without_spaces() {
        assert_eq!(name_key(" 김 등록 "), "김등록");
    }
}
