#![allow(clippy::unwrap_used)]
use console_hr_domain::cases::clocks::Anchor;

#[test]
fn register_anchor_names_round_trip_without_aliases() {
    for (anchor, name) in [
        (Anchor::EffectiveDate, "EFFECTIVE_DATE"),
        (Anchor::ExitDate, "EXIT_DATE"),
        (Anchor::LossDate, "LOSS_DATE"),
        (Anchor::StartDate, "START_DATE"),
        (Anchor::RequestDate, "REQUEST_DATE"),
        (Anchor::RegistrationDate, "REGISTRATION_DATE"),
        (Anchor::PaymentDate, "PAYMENT_DATE"),
        (Anchor::TwoYearDate, "TWO_YEAR_DATE"),
        (Anchor::ExpectedReturn, "EXPECTED_RETURN"),
    ] {
        assert_eq!(anchor.as_str(), name);
        assert_eq!(Anchor::parse(anchor.as_str()).unwrap(), anchor);
    }
    for unknown in ["", "xyzzy", "exit_date", " EXIT_DATE"] {
        assert!(Anchor::parse(unknown).is_err());
    }
}
