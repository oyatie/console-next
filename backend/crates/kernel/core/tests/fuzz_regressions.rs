#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Regressions from coverage-guided fuzzing.

use console_kernel_core::kr::PhoneE164;

#[test]
fn regression_fz3_a_stored_phone_parses_back_to_itself() {
    for (raw, expected) in [
        ("00 82 10-1234-5678", "+821012345678"),
        ("+82 00 10 1234 5678", "+821012345678"),
        ("0055100080", "+55100080"),
    ] {
        let stored = PhoneE164::parse(raw).unwrap();
        assert_eq!(PhoneE164::parse(stored.as_str()).unwrap(), stored);
        assert_eq!(stored.as_str(), expected);
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
