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
    let text = match korean_ymd(&text, 4) {
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

/// The refusal of a two-digit-year date cell, and the group answer that reads
/// a run's (`Decisions::group_answers`).
pub const TWO_DIGIT_YEAR: &str = "two_digit_year";

/// A date written with a two-digit year: `24.03.04`, `24-3-4`, `24/03/04`,
/// `24년 3월 4일`, always year first. The century is not in the cell, so this
/// is never a date by itself: [`parse_import_date`] still reads it as nothing,
/// and a run refuses the row (`two_digit_year`) until its operator says such
/// years read as year.month.day in the one plausible century.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShortYearDate {
    year: u8,
    month: u8,
    day: u8,
}

impl ShortYearDate {
    fn in_century(self, base: i32) -> Option<Date> {
        let month = Month::try_from(self.month).ok()?;
        Date::from_calendar_date(base + i32::from(self.year), month, self.day).ok()
    }

    /// The one reading (19yy or 20yy) from `earliest` to `latest`. `None`
    /// when neither century has such a day in that span, or both do: a year
    /// that is not plausible either way is refused, never placed.
    #[must_use]
    pub fn between(self, earliest: Date, latest: Date) -> Option<Date> {
        let mut fits = [1900, 2000]
            .into_iter()
            .filter_map(|base| self.in_century(base))
            .filter(|date| (earliest..=latest).contains(date));
        match (fits.next(), fits.next()) {
            (Some(date), None) => Some(date),
            _ => None,
        }
    }

    /// A date that follows `floor` (the end of a contract, a leave): within
    /// 50 years of it.
    #[must_use]
    pub fn after(self, floor: Date) -> Option<Date> {
        self.between(floor, floor.saturating_add(years(50)))
    }
}

/// `n` years as a span of days (plausibility bounds, not calendar arithmetic).
#[must_use]
pub fn years(n: i64) -> Duration {
    Duration::days(n * 365 + n / 4)
}

/// A two-digit-year date cell, in the forms [`parse_import_date`] takes with
/// four digits. `None` for anything else, a full date included.
#[must_use]
pub fn parse_short_year_date(raw: &str) -> Option<ShortYearDate> {
    let text = half_width(raw.trim());
    let text = match korean_ymd(&text, 2) {
        Some(dotted) => dotted,
        None => text,
    };
    let text = text.as_str();
    let text =
        text.split_once([' ', 'T']).map_or(
            text,
            |(day, rest)| {
                if rest.contains(':') { day } else { text }
            },
        );
    let parts: Vec<&str> = text
        .split(['-', '.', '/'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let [y, m, d] = parts.as_slice() else {
        return None;
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if y.len() != 2 || m.len() > 2 || d.len() > 2 || ![y, m, d].iter().all(|p| digits(p)) {
        return None;
    }
    Some(ShortYearDate {
        year: y.parse().ok()?,
        month: m.parse().ok()?,
        day: d.parse().ok()?,
    })
}

/// A date cell as a run reads it. A full date is itself. A two-digit year is
/// refused `two_digit_year` until the run carries the operator's `answer`
/// (`recent`), then `century` picks its century; anything else, and a
/// two-digit year with no such calendar day, is `invalid_date`.
///
/// # Errors
/// The refusal code for the row.
pub fn read_import_date(
    raw: &str,
    answer: Option<&str>,
    century: impl Fn(ShortYearDate) -> Option<Date>,
) -> Result<Date, &'static str> {
    if let Some(date) = parse_import_date(raw) {
        return Ok(date);
    }
    match (parse_short_year_date(raw), answer) {
        (Some(short), Some("recent")) => century(short).ok_or("invalid_date"),
        (Some(_), _) => Err(TWO_DIGIT_YEAR),
        (None, _) => Err("invalid_date"),
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

/// `YYYY년 M월 D일` (any spacing, an optional trailing `.`) as `YYYY.M.D`,
/// for a year of exactly `year_digits` digits.
fn korean_ymd(text: &str, year_digits: usize) -> Option<String> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let compact = compact.strip_suffix('.').unwrap_or(&compact);
    let (y, rest) = compact.split_once('년')?;
    let (m, rest) = rest.split_once('월')?;
    let d = rest.strip_suffix('일')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (y.len() == year_digits && digits(y) && digits(m) && digits(d)).then(|| format!("{y}.{m}.{d}"))
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

    fn short(raw: &str) -> ShortYearDate {
        parse_short_year_date(raw).unwrap_or_else(|| panic!("{raw} is a two-digit-year date"))
    }

    #[test]
    fn a_two_digit_year_is_its_own_kind_of_cell() {
        for raw in [
            "24.03.04",
            "24-3-4",
            "24/03/04",
            "24. 3. 4.",
            "24년 3월 4일",
            "２４.０３.０４",
            "24.03.04 00:00:00",
        ] {
            assert_eq!(short(raw), short("24.3.4"), "{raw}");
            assert_eq!(parse_import_date(raw), None, "{raw}");
        }
        // A full date, a lone year, a compact number, a sign, a third digit.
        for raw in [
            "2024.03.04",
            "4.3.24",
            "24.03",
            "240304",
            "24.+3.4",
            "24.003.4",
            "",
        ] {
            assert_eq!(parse_short_year_date(raw), None, "{raw}");
        }
    }

    #[test]
    fn a_two_digit_year_reads_in_the_one_plausible_century_or_not_at_all() {
        let today = Date::from_calendar_date(2026, Month::October, 5).unwrap();
        let hired = |raw| short(raw).between(today - years(80), today + years(1));
        let born = |raw| short(raw).between(today - years(100), today - years(14));
        assert_eq!(hired("24.03.04"), day(2024, 3, 4));
        assert_eq!(hired("98.03.04"), day(1998, 3, 4));
        assert_eq!(hired("27.03.04"), day(2027, 3, 4), "a hire next spring");
        // 2030 is too far ahead and 1930 too long ago: no reading, no guess.
        assert_eq!(hired("30.01.01"), None);
        assert_eq!(born("85.05.05"), day(1985, 5, 5));
        assert_eq!(born("05.05.05"), day(2005, 5, 5));
        // Six years old or a hundred and six.
        assert_eq!(born("20.01.01"), None);
        // Only one century has the day; neither has it.
        assert_eq!(hired("00.02.29"), day(2000, 2, 29));
        assert_eq!(hired("25.02.29"), None);
        // A span of a century or more holds both readings: still no guess.
        assert_eq!(
            short("24.03.04").between(day(1900, 1, 1).unwrap(), today),
            None
        );
        assert_eq!(
            short("99.12.31").after(day(1998, 7, 1).unwrap()),
            day(1999, 12, 31)
        );
        assert_eq!(short("97.12.31").after(day(1998, 7, 1).unwrap()), None);
    }

    #[test]
    fn a_date_cell_reads_by_the_operators_answer_only() {
        let any = |short: ShortYearDate| {
            short.between(day(1950, 1, 1).unwrap(), day(2027, 1, 1).unwrap())
        };
        let none = |_: ShortYearDate| -> Option<Date> { panic!("no answer, no reading") };
        assert_eq!(
            read_import_date("2024-03-04", None, none),
            Ok(day(2024, 3, 4).unwrap())
        );
        assert_eq!(
            read_import_date("24.03.04", None, none),
            Err(TWO_DIGIT_YEAR)
        );
        assert_eq!(
            read_import_date("24.03.04", Some("other"), none),
            Err(TWO_DIGIT_YEAR)
        );
        assert_eq!(
            read_import_date("24.03.04", Some("recent"), any),
            Ok(day(2024, 3, 4).unwrap())
        );
        assert_eq!(
            read_import_date("24.02.30", Some("recent"), any),
            Err("invalid_date")
        );
        assert_eq!(
            read_import_date("입사일", Some("recent"), any),
            Err("invalid_date")
        );
        // Year first, always: the answer's label says so.
        assert_eq!(
            read_import_date("03/04/24", Some("recent"), any),
            Ok(day(2003, 4, 24).unwrap())
        );
    }

    #[test]
    fn names_compare_without_spaces() {
        assert_eq!(name_key(" 김 등록 "), "김등록");
    }
}
