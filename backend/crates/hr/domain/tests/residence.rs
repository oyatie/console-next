// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_hr_domain::residence::{ResidenceStatus, StatusVersion, in_force, validate};
use time::macros::date;

fn row() -> ResidenceStatus {
    ResidenceStatus {
        code: "E-7".into(),
        valid_from: date!(2026 - 11 - 12),
        valid_to: Some(date!(2027 - 11 - 12)),
    }
}
fn catalog() -> Vec<StatusVersion> {
    vec![StatusVersion {
        code: "E-7".into(),
        valid_from: date!(2026 - 10 - 02),
        valid_to: None,
    }]
}
#[test]
fn refusal_codes_have_korean_messages() {
    let status = row();
    for (nationality, expected) in [
        (Some("KR"), "residence_status_not_applicable"),
        (None, "residence_status_nationality_required"),
    ] {
        let error = validate(&status, nationality, &catalog(), &[]).unwrap_err();
        assert_eq!(error.code, Some(expected));
        assert!(error.message.contains("국적"));
    }
    let error = validate(&status, Some("VN"), &[], &[]).unwrap_err();
    assert_eq!(error.code, Some("residence_status_unknown"));
    assert!(error.message.contains("체류자격"));
    assert!(validate(&status, Some("VN"), &catalog(), &[]).is_ok());
    let unknown = ResidenceStatus {
        code: "Z-1".into(),
        ..row()
    };
    assert_eq!(
        validate(&unknown, Some("VN"), &catalog(), &[])
            .unwrap_err()
            .code,
        Some("residence_status_unknown")
    );
}
#[test]
fn invalid_period_and_overlap_are_refused() {
    let mut status = row();
    for end in [status.valid_from, status.valid_from.previous_day().unwrap()] {
        status.valid_to = Some(end);
        assert_eq!(
            validate(&status, Some("VN"), &catalog(), &[])
                .unwrap_err()
                .code,
            Some("residence_status_dates")
        );
    }
    let status = row();
    assert_eq!(
        validate(&status, Some("VN"), &catalog(), &[row()])
            .unwrap_err()
            .code,
        Some("residence_status_overlap")
    );
    let next = ResidenceStatus {
        valid_from: status.valid_to.unwrap(),
        valid_to: None,
        ..row()
    };
    assert!(validate(&next, Some("VN"), &catalog(), &[row()]).is_ok());
    assert!(validate(&status, Some("VN"), &catalog(), std::slice::from_ref(&next)).is_ok());
    assert_eq!(
        validate(&next, Some("VN"), &catalog(), std::slice::from_ref(&next))
            .unwrap_err()
            .code,
        Some("residence_status_overlap")
    );
}
#[test]
fn reference_membership_uses_effective_start_and_exclusive_end() {
    let status = row();
    let mut versions = catalog();
    versions[0].valid_to = Some(status.valid_from);
    assert_eq!(
        validate(&status, Some("VN"), &versions, &[])
            .unwrap_err()
            .code,
        Some("residence_status_unknown")
    );
    versions[0].valid_from = status.valid_from.next_day().unwrap();
    versions[0].valid_to = None;
    assert_eq!(
        validate(&status, Some("VN"), &versions, &[])
            .unwrap_err()
            .code,
        Some("residence_status_unknown")
    );
    versions[0].valid_from = status.valid_from;
    assert!(validate(&status, Some("VN"), &versions, &[]).is_ok());
}
#[test]
fn lookup_preserves_gaps_history_and_open_ends() {
    let status = row();
    let next = ResidenceStatus {
        code: "F-5".into(),
        valid_from: date!(2028 - 01 - 01),
        valid_to: None,
    };
    let rows = [next, status];
    for (on, expected) in [
        (date!(2026 - 11 - 11), None),
        (date!(2026 - 11 - 12), Some("E-7")),
        (date!(2027 - 11 - 11), Some("E-7")),
        (date!(2027 - 11 - 12), None),
        (date!(2028 - 01 - 01), Some("F-5")),
        (date!(2099 - 01 - 01), Some("F-5")),
    ] {
        assert_eq!(
            in_force(&rows, on).unwrap().map(|r| r.code.as_str()),
            expected
        );
    }
    assert_eq!(
        in_force(&[row(), row()], date!(2026 - 11 - 12))
            .unwrap_err()
            .code,
        Some("residence_status_overlap")
    );
}
