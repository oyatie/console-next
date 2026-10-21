#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Pins what cargo-mutants found unpinned in hr-domain (TS-14,
//! tools/lanes/mutants.sh): the shared text and date normalisers at their
//! edges, and the two RRN detectors that keep 주민등록번호 out of every
//! column but its own (a surviving mutant there is a privacy guard no test
//! holds).

use console_hr_domain::import::pii::is_stripped_zero_rrn;
use console_hr_domain::import::rrn::{contains_rrn_shaped, is_rrn_value};
use console_hr_domain::registration_void::VoidBasis;
use console_hr_domain::text::{
    normalize_date_text, normalize_limited_text, normalize_optional_limited_text,
    normalize_optional_text, parse_yyyy_mm_dd,
};

#[test]
fn optional_text_is_trimmed_and_blank_is_none() {
    assert_eq!(
        normalize_optional_text(Some(" 가나 ".into())).as_deref(),
        Some("가나")
    );
    assert_eq!(normalize_optional_text(Some("   ".into())), None);
    assert_eq!(normalize_optional_text(None), None);
}

#[test]
fn dates_are_exactly_yyyy_mm_dd_and_real() {
    assert_eq!(normalize_date_text(" 2024-02-29 ").unwrap(), "2024-02-29");
    for bad in [
        "2024-2-29",
        "24-02-29",
        "2024-02-9",
        "2024-02-290",
        "02024-02-29",
        "2024/02/29",
        "2024-02-29-1",
        "2023-02-29",
        "2024-13-01",
        "abcd-02-01",
    ] {
        assert!(parse_yyyy_mm_dd(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn limited_text_takes_exactly_max_characters() {
    assert_eq!(
        normalize_limited_text(" 가나다 ".into(), 3, "f").unwrap(),
        "가나다"
    );
    assert!(normalize_limited_text("가나다라".into(), 3, "f").is_err());
    assert!(normalize_limited_text("  ".into(), 3, "f").is_err());
    assert_eq!(
        normalize_optional_limited_text(Some("가나다".into()), 3, "f")
            .unwrap()
            .as_deref(),
        Some("가나다")
    );
    assert!(normalize_optional_limited_text(Some("가나다라".into()), 3, "f").is_err());
    assert_eq!(
        normalize_optional_limited_text(Some(" ".into()), 3, "f").unwrap(),
        None
    );
}

#[test]
fn rrn_shapes_are_found_anywhere_but_never_inside_a_longer_number() {
    for hit in [
        "900101-1234567",
        "9001011234567",
        "주민 900101-2234567 끝",
        "x900101-8234568",
        "a9001015234567b",
    ] {
        assert!(contains_rrn_shaped(hit), "{hit} must match");
        assert!(is_rrn_value(hit), "{hit}");
    }
    for miss in [
        "1900101-1234567",
        "900101-12345678",
        "900101-9234567",
        "900101-0234567",
        "90010-1234567",
        "900101--1234567",
        "900101-123456",
        "",
    ] {
        assert!(!contains_rrn_shaped(miss), "{miss} must not match");
    }
}

#[test]
fn a_stripped_leading_zero_rrn_is_only_an_11_or_12_digit_2000s_date_with_its_gender_digit() {
    for hit in ["101013000003", "101013000003.0", "402293123456"] {
        assert!(is_stripped_zero_rrn(hit), "{hit}");
        assert!(is_rrn_value(hit), "{hit}");
    }
    for miss in [
        "1010130000030",
        "1010130000",
        "10101300000",
        "010101300000",
        "10101300000a",
        "101011000003",
        "502293123456",
        "113013000003",
        "101323000003",
    ] {
        assert!(!is_stripped_zero_rrn(miss), "{miss}");
    }
}

#[test]
fn void_bases_are_stored_by_their_own_names() {
    assert_eq!(VoidBasis::NeverStarted.as_str(), "NEVER_STARTED");
    assert_eq!(
        VoidBasis::AttestedWithinWindow.as_str(),
        "ATTESTED_WITHIN_WINDOW"
    );
}
