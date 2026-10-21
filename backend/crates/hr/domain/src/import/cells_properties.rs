//! W05 property tests of [`parse_import_date`], exhaustive over every day
//! from 1900-03-01 to 2099-12-31 (no sampling: 73k days × each spelling).

use time::{Date, Duration, Month};

use super::parse_import_date;

fn every_day() -> impl Iterator<Item = Date> {
    let first = Date::from_calendar_date(1900, Month::March, 1).unwrap();
    let last = Date::from_calendar_date(2099, Month::December, 31).unwrap();
    std::iter::successors(Some(first), move |d| d.next_day().filter(|n| *n <= last))
}

#[test]
fn every_spelling_of_every_day_reads_as_that_day() {
    let epoch = Date::from_calendar_date(1899, Month::December, 30).unwrap();
    for date in every_day() {
        let (y, m, d) = (date.year(), u8::from(date.month()), date.day());
        let serial = (date - epoch).whole_days();
        for raw in [
            format!("{y}년 {m}월 {d}일"),
            format!("{y}년{m:02}월{d:02}일"),
            format!("{y}. {m}. {d}."),
            format!("{y}.{m}.{d}"),
            format!("{y}/{m:02}/{d:02}"),
            format!("{y}{m:02}{d:02}"),
            format!("{date} 00:00:00"),
            serial.to_string(),
        ] {
            assert_eq!(parse_import_date(&raw), Some(date), "{raw}");
        }
    }
}

#[test]
fn a_day_past_the_month_end_is_never_a_date() {
    for date in every_day().filter(|d| d.next_day().is_some_and(|n| n.day() == 1)) {
        let (y, m, d) = (date.year(), u8::from(date.month()), date.day() + 1);
        for raw in [format!("{y}년 {m}월 {d}일"), format!("{y}.{m}.{d}")] {
            assert_eq!(parse_import_date(&raw), None, "{raw}");
        }
    }
}

#[test]
fn a_two_digit_year_is_never_read() {
    let first = Date::from_calendar_date(2000, Month::January, 1).unwrap();
    for n in 0..3_653 {
        let date = first + Duration::days(n);
        let (y, m, d) = (date.year() % 100, u8::from(date.month()), date.day());
        for raw in [
            format!("{y:02}년 {m}월 {d}일"),
            format!("{y:02}.{m:02}.{d:02}"),
            format!("{y:02}-{m:02}-{d:02}"),
        ] {
            assert_eq!(parse_import_date(&raw), None, "{raw}");
        }
    }
}
