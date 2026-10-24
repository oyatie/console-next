// SPDX-License-Identifier: LicenseRef-Proprietary
use console_entity_application::registration_check::{
    CheckAnswer, CheckKind, FakeRegistrationCheck, RegistrationCheck, UnavailableReason,
    verification_tier,
};

#[test]
fn current_number_and_latest_answer_own_the_tier() {
    let mut answer = CheckAnswer::status("1234567890", "01");
    assert_eq!(verification_tier(Some("1234567890"), Some(&answer)), "T1");
    assert_eq!(verification_tier(Some("9876543210"), Some(&answer)), "NONE");
    answer.kind = CheckKind::Validate;
    answer.valid = Some("01".into());
    assert_eq!(verification_tier(Some("1234567890"), Some(&answer)), "T2");
    answer.valid = Some("02".into());
    answer.status_code = None;
    assert_eq!(verification_tier(Some("1234567890"), Some(&answer)), "NONE");
    assert_eq!(verification_tier(None, Some(&answer)), "NONE");
}

#[test]
fn fake_availability_is_honest_and_schedule_exposes_only_status() {
    let fake = FakeRegistrationCheck::unavailable(UnavailableReason::NotConfigured);
    assert_eq!(
        fake.availability().reason,
        Some(UnavailableReason::NotConfigured)
    );
    assert!(!fake.availability().available);
    assert!(
        FakeRegistrationCheck::configured(vec![])
            .availability()
            .available
    );
}
