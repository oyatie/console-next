//! BW-10 typed cells: a spreadsheet date and a person's name as the import
//! compares them. Pure; the dry run turns a `None` date into a per-row refusal.

use time::{Date, Duration, Month};

/// Structured failure reason returned by [`parse_import_date_checked`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateParseError {
    TwoDigitYear,
    InvalidFormat,
}

/// A date cell as Korean HR workbooks write it: `2024-03-04`, `2024.03.04`,
/// `2024/3/4`, `2024. 3. 4.`, `20240304`, 2024, 3 and 4 each followed by its
/// Korean year, month or day marker (W05), a trailing time (`… 00:00:00`), or an Excel
/// serial day number (what a date-formatted cell reads as). Full-width digits
/// read as digits. Distinguishes two-digit years from general format errors.
///
/// # Errors
/// [`DateParseError::TwoDigitYear`] when a 2-digit year (`YY-MM-DD`, `YY.MM.DD`,
/// `YY/MM/DD`, or `YY/M/D` with Korean Y/M/D markers) is supplied instead of a 4-digit year;
/// [`DateParseError::InvalidFormat`] otherwise.
pub fn parse_import_date_checked(raw: &str) -> Result<Date, DateParseError> {
    let text = half_width(raw.trim());
    // 2024, 3 and 4 each followed by its Korean year, month or day marker →
    // `2024.3.4`: only with all three markers, in order.
    let text = match korean_ymd_checked(&text)? {
        Some(dotted) => dotted,
        None => text,
    };
    let text = text.as_str();
    let text = text.split_once([' ', 'T']).map_or(text, |(day, rest)| {
        // `2024. 3. 4.` keeps its spaces; only a time part is cut.
        if rest.contains(':') { day } else { text }
    });
    if text.len() == 6 && text.bytes().all(|b| b.is_ascii_digit()) {
        let month = text[2..4].parse::<u8>().unwrap_or(0);
        let day = text[4..6].parse::<u8>().unwrap_or(0);
        if (1..=12).contains(&month) && (1..=31).contains(&day) {
            return Err(DateParseError::TwoDigitYear);
        }
        return Err(DateParseError::InvalidFormat);
    }
    if let Some(date) = excel_serial(text) {
        return Ok(date);
    }
    if text.len() == 8 && text.bytes().all(|b| b.is_ascii_digit()) {
        return ymd(&text[..4], &text[4..6], &text[6..]).ok_or(DateParseError::InvalidFormat);
    }
    let parts: Vec<&str> = text
        .split(['-', '.', '/'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let is_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match parts.as_slice() {
        [y, m, d] if y.len() == 4 && m.len() <= 2 && d.len() <= 2 => {
            ymd(y, m, d).ok_or(DateParseError::InvalidFormat)
        }
        [y, m, d]
            if y.len() == 2
                && is_digits(y)
                && m.len() <= 2
                && is_digits(m)
                && d.len() <= 2
                && is_digits(d) =>
        {
            Err(DateParseError::TwoDigitYear)
        }
        _ => Err(DateParseError::InvalidFormat),
    }
}

/// A date cell as Korean HR workbooks write it. `None` for anything invalid (including a
/// two-digit year); never a guess.
#[must_use]
pub fn parse_import_date(raw: &str) -> Option<Date> {
    parse_import_date_checked(raw).ok()
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

/// A year, month and day each followed by its Korean marker (any spacing, an
/// optional trailing `.`) as `YYYY.M.D`, distinguishing 2-digit years.
fn korean_ymd_checked(text: &str) -> Result<Option<String>, DateParseError> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let compact = compact.strip_suffix('.').unwrap_or(&compact);
    let Some((y, rest)) = compact.split_once('\u{B144}') else {
        return Ok(None);
    };
    let Some((m, rest)) = rest.split_once('\u{C6D4}') else {
        return Ok(None);
    };
    let Some(d) = rest.strip_suffix('\u{C77C}') else {
        return Ok(None);
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if y.len() == 2 && digits(y) && digits(m) && digits(d) {
        return Err(DateParseError::TwoDigitYear);
    }
    Ok((y.len() == 4 && digits(y) && digits(m) && digits(d)).then(|| format!("{y}.{m}.{d}")))
}

fn ymd(y: &str, m: &str, d: &str) -> Option<Date> {
    // `str::parse` takes a sign (`"+3"`): only digits are a date part.
    if ![y, m, d]
        .iter()
        .all(|p| p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let year: i32 = y.parse().ok()?;
    if year < 1900 {
        return None;
    }
    let month = Month::try_from(m.parse::<u8>().ok()?).ok()?;
    Date::from_calendar_date(year, month, d.parse().ok()?).ok()
}

/// Excel's day 1 is 1900-01-01 counted from 1899-12-30 (the 1900 leap-year
/// bug); only whole numbers from 1900-03-01 (61) to 2100-12-31 (73415) count.
fn excel_serial(text: &str) -> Option<Date> {
    if text.starts_with('0') {
        return None;
    }
    let days: f64 = text.parse().ok()?;
    if days.fract() != 0.0 || !(61.0..=73_415.0).contains(&days) {
        return None;
    }
    let epoch = Date::from_calendar_date(1899, Month::December, 30).ok()?;
    #[allow(clippy::cast_possible_truncation)]
    epoch.checked_add(Duration::days(days as i64))
}

/// Matches PostgreSQL `\s` regex whitespace so Rust `name_key` produces the exact same
/// normalized key as `lower(regexp_replace(name, '\s', '', 'g'))` in SQL queries and indexes.
/// PostgreSQL `\s` excludes `\u{0085}`, `\u{00A0}`, `\u{2007}`, and `\u{202F}`.
const fn is_pg_regex_whitespace(c: char) -> bool {
    c.is_whitespace() && !matches!(c, '\u{0085}' | '\u{00A0}' | '\u{2007}' | '\u{202F}')
}

/// A name as identity compares it: PostgreSQL `\s` whitespace removed and lowercased.
#[must_use]
pub fn name_key(name: &str) -> String {
    name.chars()
        .filter(|c| !is_pg_regex_whitespace(*c))
        .collect::<String>()
        .to_lowercase()
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
            let expected = if raw.starts_with("24-") || raw.starts_with("11") {
                DateParseError::TwoDigitYear
            } else {
                DateParseError::InvalidFormat
            };
            assert_eq!(parse_import_date_checked(raw), Err(expected), "{raw}");
        }
    }

    /// regression (W05): the walkthrough's 75 rows of 2011, 4 and 10 each
    /// followed by its Korean year, month or day marker were refused
    /// `invalid_date`; full-width digits likewise.
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
        assert_eq!(name_key("Alex Kim"), "alexkim");
        assert_eq!(name_key("alex  kim"), "alexkim");
    }

    #[test]
    fn name_key_matches_postgres_regex_whitespace_including_nbsp() {
        assert_eq!(name_key("Kim\u{00A0}Nbsp"), "kim\u{00a0}nbsp");
        assert_eq!(name_key("KIM\u{00A0}NBSP"), "kim\u{00a0}nbsp");
        assert_ne!(name_key("Kim\u{00A0}Nbsp"), name_key("Kim Nbsp"));
        assert_eq!(name_key("Kim\u{3000}Nbsp"), "kimnbsp");
        assert_eq!(name_key("Kim\u{2003}Nbsp"), "kimnbsp");
        assert_eq!(name_key("Kim\u{2009}Nbsp"), "kimnbsp");
        assert_eq!(name_key("Kim\u{0085}Nbsp"), "kim\u{0085}nbsp");
        assert_eq!(name_key("Kim\u{2007}Nbsp"), "kim\u{2007}nbsp");
        assert_eq!(name_key("Kim\u{202F}Nbsp"), "kim\u{202f}nbsp");
    }

    #[test]
    fn regression_yymmdd_and_pre_1900_years_are_rejected_while_excel_serials_work() {
        for raw in ["240304", "010101", "990101", "950304", "260601"] {
            assert_eq!(
                parse_import_date_checked(raw),
                Err(DateParseError::TwoDigitYear),
                "{raw}"
            );
        }
        for raw in [
            "0024-01-01",
            "00240101",
            "1899-12-31",
            "1899.12.31",
            "1899/12/31",
        ] {
            assert_eq!(
                parse_import_date_checked(raw),
                Err(DateParseError::InvalidFormat),
                "{raw}"
            );
        }
        assert_eq!(
            parse_import_date_checked("45000"),
            Ok(day(2023, 3, 15).unwrap())
        );
        assert_eq!(
            parse_import_date_checked("45355"),
            Ok(day(2024, 3, 4).unwrap())
        );
        assert_eq!(
            parse_import_date_checked("1900-01-01"),
            Ok(day(1900, 1, 1).unwrap())
        );
    }
}
