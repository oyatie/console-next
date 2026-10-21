#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Findings of the coverage-guided fuzzer (`backend/fuzz`, ids FZ-n in
//! `backend/fuzz/README.md`), pinned as regression tests. An `#[ignore]`d test
//! is a finding still open in product code: it fails today and passes once the
//! owner fixes it; then drop the `ignore` and the fuzz target's `known` skip.

use console_kernel_core::kr::PhoneE164;

/// FZ-3: a stored phone must parse back to itself (the canonical form is a
/// fixed point). Input with the international prefix `00 82 …` or a second
/// `0` after `+82` is stored as `+820…`, which re-parses to another number, so
/// the same phone can sit in two rows under two values.
#[test]
#[ignore = "regression FZ-3 open, owner kernel: PhoneE164 stores +820… that re-parses to another value"]
fn regression_fz3_a_stored_phone_parses_back_to_itself() {
    for raw in ["00 82 10-1234-5678", "+82 00 10 1234 5678", "0055100080"] {
        let stored = PhoneE164::parse(raw).expect("accepted today; a refusal also fixes FZ-3");
        let again = PhoneE164::parse(stored.as_str()).map(|p| p.as_str().to_owned());
        assert_eq!(again.ok().as_deref(), Some(stored.as_str()), "{raw:?}");
    }
}

/// Negative: the refusals the fuzzer leaned on must keep refusing.
#[test]
fn phone_parse_keeps_refusing_numbers_that_are_not_e164() {
    for raw in [
        "",
        "0",
        "+",
        "+0",
        "+0123456789",
        "010",
        "1588",
        "+1234567",
        "+1234567890123456",
    ] {
        assert!(PhoneE164::parse(raw).is_err(), "{raw:?} must be refused");
    }
}
