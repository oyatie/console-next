//! Property tests for the pure HR import rules: the `YYYY-MM-DD` reader, the
//! 주민등록번호 detectors that keep RRNs out of stored rows, and header
//! matching. Default 256 cases; the nightly `fuzz` profile raises
//! `PROPTEST_CASES` (see `.config/nextest.toml`).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_hr_domain::import::classification::{
    employee_import_target_for_header, import_header_match_key, normalize_header_label,
};
use console_hr_domain::import::fields::EMPLOYEE_IMPORT_FIELD_DEFINITIONS;
use console_hr_domain::import::rrn::{contains_rrn_shaped, is_rrn_value};
use console_hr_domain::text::{normalize_date_text, parse_yyyy_mm_dd};
use proptest::prelude::*;
use time::{Date, Duration};

fn any_date() -> impl Strategy<Value = Date> {
    // 1000-01-01 ..= 9999-12-31: every date with a four-digit year.
    (0i64..3_287_181).prop_map(|n| time::macros::date!(1000 - 01 - 01) + Duration::days(n))
}

/// Text with no ASCII digit, so it cannot extend a digit run it borders.
fn non_digit_text() -> impl Strategy<Value = String> {
    "[^0-9]{0,6}"
}

/// A date in the 2000s, written `YYMMDD`.
fn yymmdd_2000s() -> impl Strategy<Value = String> {
    (0i64..3_653).prop_map(|n| {
        let d = time::macros::date!(2000 - 01 - 01) + Duration::days(n);
        format!(
            "{:02}{:02}{:02}",
            d.year() % 100,
            u8::from(d.month()),
            d.day()
        )
    })
}

proptest! {
    #[test]
    fn iso_dates_round_trip(date in any_date(), pad in "[ \t]{0,2}") {
        let text = date.to_string();
        prop_assert_eq!(parse_yyyy_mm_dd(&format!("{pad}{text}{pad}")).unwrap(), date);
        prop_assert_eq!(normalize_date_text(&text).unwrap(), text);
    }

    /// Whatever the reader accepts is already canonical: no sign, no
    /// non-digit sneaks through `str::parse` (`"+1"` is a valid `u8`).
    #[test]
    fn accepted_dates_are_canonical(
        year in "\\+[0-9]{3}|[0-9]{4}",
        month in "\\+[1-9]|0[1-9]|1[0-2]",
        day in "\\+[1-9]|0[1-9]|1[0-9]|2[0-8]",
    ) {
        let raw = format!("{year}-{month}-{day}");
        if let Ok(normalized) = normalize_date_text(&raw) {
            prop_assert_eq!(normalized.as_str(), raw.trim());
        }
    }

    #[test]
    fn arbitrary_text_never_panics_the_date_reader(raw in ".{0,16}") {
        let _ = parse_yyyy_mm_dd(&raw);
    }

    /// `YYMMDD-GNNNNNN` (gender 1–8, dash optional) is found anywhere in a
    /// cell, so it is dropped before a row is stored.
    #[test]
    fn rrn_shape_is_found_inside_any_text(
        yymmdd in "[0-9]{6}",
        gender in 1u8..=8,
        serial in "[0-9]{6}",
        dash in any::<bool>(),
        before in non_digit_text(),
        after in non_digit_text(),
    ) {
        let rrn = format!("{yymmdd}{}{gender}{serial}", if dash { "-" } else { "" });
        let cell = format!("{before}{rrn}{after}");
        prop_assert!(contains_rrn_shaped(&cell), "{cell:?}");
        prop_assert!(is_rrn_value(&cell), "{cell:?}");
    }

    #[test]
    fn a_non_rrn_gender_digit_is_not_an_rrn(
        yymmdd in "[0-9]{6}",
        gender in prop::sample::select(vec![0u8, 9]),
        serial in "[0-9]{6}",
        before in non_digit_text(),
        after in non_digit_text(),
    ) {
        let cell = format!("{before}{yymmdd}-{gender}{serial}{after}");
        prop_assert!(!contains_rrn_shaped(&cell), "{cell:?}");
    }

    /// A 2000s RRN typed as a number loses its leading zero(s) in Excel; it is
    /// still caught, with or without the `.0` a float renders with.
    ///
    /// births 2000-01..2000-09 lose three zeros and leave 10 digits,
    /// the same shape as a 10-digit 사번 (`2024000123`), so `pii.rs` keeps
    /// them by design. Excluded here; a header-level rule would close it.
    #[test]
    fn excel_stripped_2000s_rrn_is_caught(
        yymmdd in yymmdd_2000s().prop_filter("10-digit case kept by design", |d| !d.starts_with("000")),
        gender in prop::sample::select(vec![3u8, 4, 7, 8]),
        serial in "[0-9]{6}",
        float_suffix in any::<bool>(),
    ) {
        let number: u64 = format!("{yymmdd}{gender}{serial}").parse().unwrap();
        let cell = format!("{number}{}", if float_suffix { ".0" } else { "" });
        prop_assert!(is_rrn_value(&cell), "{cell:?}");
    }

    #[test]
    fn header_normalisation_is_idempotent(raw in ".{0,24}") {
        let label = normalize_header_label(&raw);
        prop_assert_eq!(normalize_header_label(&label), label.clone());
        prop_assert!(!label.chars().any(char::is_whitespace));
        let key = import_header_match_key(&raw);
        prop_assert_eq!(import_header_match_key(&key), key);
    }

    /// Every catalogued alias still maps to its target when a person wraps it
    /// in spaces, brackets or `_` noise (`" 입사 일자 (필수)"` is a different
    /// header, but `"[입사일자]"` and `"입 사 일 자"` are the same one).
    #[test]
    fn decorated_aliases_map_to_their_target(
        field_at in any::<prop::sample::Index>(),
        alias_at in any::<prop::sample::Index>(),
        noise in prop::collection::vec(prop::sample::select(vec![" ", "\t", "_", "-", "(", ")", "[", "]", "·", ".", ":", "/"]), 0..4),
        at in prop::collection::vec(any::<prop::sample::Index>(), 0..4),
    ) {
        let field = &EMPLOYEE_IMPORT_FIELD_DEFINITIONS[field_at.index(EMPLOYEE_IMPORT_FIELD_DEFINITIONS.len())];
        let alias = field.aliases[alias_at.index(field.aliases.len())];
        let mut chars: Vec<String> = alias.chars().map(String::from).collect();
        for (piece, at) in noise.iter().zip(&at) {
            chars.insert(at.index(chars.len() + 1), (*piece).to_owned());
        }
        let header = normalize_header_label(&chars.concat());
        prop_assert_eq!(employee_import_target_for_header(&header), Some(field.target), "{:?}", header);
    }
}
