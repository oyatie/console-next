#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Findings of the coverage-guided fuzzer (`backend/fuzz`, ids FZ-n in
//! `backend/fuzz/README.md`), pinned as regression tests. An `#[ignore]`d test
//! is a finding still open in product code: it fails today and passes once the
//! owner fixes it; then drop the `ignore` and the fuzz target's `known` skip.
//! The plain tests are the refusals that must keep refusing.

use console_hr_domain::import::rrn::is_rrn_value;
use console_hr_domain::import::rrn_value::Rrn;

/// FZ-1: 13 bytes, no hyphen, a multi-byte character across byte 6. The RRN
/// column of an uploaded roster reaches `Rrn::parse` (import/sheet.rs), so one
/// such cell panicked the import request.
#[test]
#[ignore = "regression FZ-1 open, owner IMPORT: Rrn::parse panics (split_at(6) inside a character)"]
fn regression_fz1_rrn_parse_refuses_a_multibyte_cell_without_panicking() {
    for cell in [
        "12345가67890",
        "aaaaa가bbbbb",
        "90010å000000",
        "1234５6789012",
    ] {
        assert_eq!(
            cell.len(),
            13,
            "{cell:?} must stay 13 bytes to reach split_at(6)"
        );
        let parsed = std::panic::catch_unwind(|| Rrn::parse(cell).is_ok());
        assert_eq!(parsed.ok(), Some(false), "{cell:?}: refused, not a panic");
    }
}

/// FZ-4: the vault seals what `Rrn::parse` accepts, and `is_rrn_value` is the
/// rule that keeps an RRN out of every other column and of stored text. Parse
/// takes a hyphen anywhere and trims control whitespace; the scrub does
/// neither, so these cells are sealed in the RRN column and kept verbatim
/// anywhere else.
#[test]
#[ignore = "regression FZ-4 open, owner IMPORT: Rrn::parse accepts shapes is_rrn_value misses"]
fn regression_fz4_every_cell_the_vault_accepts_is_one_the_scrub_catches() {
    for cell in [
        "9003044700-110",
        "101-1111111012",
        "0001136-480926",
        "307018364800\u{b}",
        "111113110111\r",
    ] {
        if Rrn::parse(cell).is_ok() {
            assert!(
                is_rrn_value(cell),
                "{cell:?} is sealed as an RRN but not scrubbed"
            );
        }
    }
}

/// Negative: what is not an RRN stays refused (shape, gender digit, date).
#[test]
fn rrn_parse_keeps_refusing_what_is_not_an_rrn() {
    for cell in [
        "",
        "900101-123456",
        "900101-9234567",
        "900101-0234567",
        "901301-1234567",
        "900230-1234567",
        "000229-1234567",
        "9001011234567890",
        "90010l-1234567",
        "900101--1234567",
        "12345678901",
    ] {
        assert!(Rrn::parse(cell).is_err(), "{cell:?} must be refused");
    }
    // A leap day in a leap year is a real date (2000: gender digit 3/4).
    assert!(Rrn::parse("000229-3234567").is_ok());
}
