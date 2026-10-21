#![allow(clippy::unwrap_used)]

use super::*;
use crate::lifecycle::signoffs::EmployeeLifecycleSignoffs;

fn head() -> EmployeeForLifecycle {
    EmployeeForLifecycle {
        company: "Co".into(),
        org_unit: None,
        org_unit_id: None,
        position: Some("대리".into()),
        job_title_id: None,
        employment_status: "ACTIVE".into(),
        employment_type: Some("CONTRACT".into()),
        contract_start_date: parse_yyyy_mm_dd("2026-01-01").ok(),
        contract_end_date: parse_yyyy_mm_dd("2026-12-31").ok(),
        classification: Classification {
            grade_id: Some(Uuid::from_u128(1)),
            position_kind_id: Some(Uuid::from_u128(2)),
            job: Some("영업".into()),
            ..Classification::default()
        },
    }
}

fn event(
    event_type: &str,
    classify: ClassificationChange,
) -> NormalizedEmployeeLifecycleTransition {
    NormalizedEmployeeLifecycleTransition {
        event_type: event_type.into(),
        to_status: "ACTIVE".into(),
        to_company: None,
        to_org_unit: None,
        to_org_unit_id: None,
        to_position: None,
        expected_return_date: None,
        contract_end_date: None,
        leave_type: None,
        to_job_title_id: None,
        reason_code: None,
        to_workplace_id: None,
        classify,
        effective_date: "2026-07-01".into(),
        comment: "c".into(),
        signoffs: EmployeeLifecycleSignoffs::default(),
    }
}

#[test]
fn fields_belong_to_their_event() {
    let grade = ClassificationChange {
        to_grade_id: Some(Uuid::nil()),
        ..ClassificationChange::default()
    };
    assert!(normalize_classification_change("PROMOTE", grade.clone(), None).is_ok());
    assert!(normalize_classification_change("APPOINT", grade, None).is_err());
    assert!(
        normalize_classification_change("APPOINT", ClassificationChange::default(), None).is_err()
    );
    let vacate = ClassificationChange {
        vacate_position_kind: true,
        ..ClassificationChange::default()
    };
    assert!(normalize_classification_change("APPOINT", vacate.clone(), None).is_ok());
    assert!(normalize_classification_change("TRANSFER", vacate, None).is_err());
    let both = ClassificationChange {
        vacate_position_kind: true,
        to_position_kind_id: Some(Uuid::nil()),
        ..ClassificationChange::default()
    };
    assert!(normalize_classification_change("APPOINT", both, None).is_err());
}

#[test]
fn a_change_to_contract_needs_its_end() {
    let to = |t: &str| ClassificationChange {
        to_employment_type: Some(t.into()),
        ..ClassificationChange::default()
    };
    let etc = "EMPLOYMENT_TYPE_CHANGE";
    assert!(normalize_classification_change(etc, to("contract"), None).is_err());
    let ok = normalize_classification_change(etc, to(" contract "), Some("2027-06-30")).unwrap();
    assert_eq!(ok.to_employment_type.as_deref(), Some("CONTRACT"));
    assert!(normalize_classification_change(etc, to("REGULAR"), Some("2027-06-30")).is_err());
    assert!(normalize_classification_change(etc, to("NOPE"), None).is_err());
    assert!(normalize_classification_change(etc, ClassificationChange::default(), None).is_err());
    assert!(normalize_classification_change("PROMOTE", to("REGULAR"), None).is_err());
}

#[test]
fn appoint_keeps_what_it_does_not_name() {
    let head = head();
    let job = Uuid::from_u128(9);
    let mut t = event(
        "APPOINT",
        ClassificationChange {
            to_job_id: Some(job),
            to_job: Some("인사".into()),
            vacate_position_kind: true,
            ..ClassificationChange::default()
        },
    );
    let after = classification_after(&head, &t);
    assert_eq!(after.grade_id, head.classification.grade_id);
    assert_eq!(after.position_kind_id, None);
    assert_eq!(
        (after.job_id, after.job.as_deref()),
        (Some(job), Some("인사"))
    );
    assert_eq!(classification_noop(&head, &t), Some(false));
    // Free text clears the 직무 id.
    t.classify = ClassificationChange {
        to_job: Some("영업".into()),
        ..ClassificationChange::default()
    };
    assert_eq!(classification_noop(&head, &t), Some(true));
}

#[test]
fn promote_noop_reads_grade_and_title() {
    let head = head();
    let same = ClassificationChange {
        to_grade_id: Some(Uuid::from_u128(1)),
        ..ClassificationChange::default()
    };
    let mut t = event("PROMOTE", same);
    assert_eq!(classification_noop(&head, &t), Some(true));
    t.to_position = Some("과장".into());
    assert_eq!(classification_noop(&head, &t), Some(false));
    assert_eq!(
        classification_noop(&head, &event("TRANSFER", ClassificationChange::default())),
        None
    );
}

#[test]
fn a_change_away_from_contract_closes_the_window() {
    let mut head = head();
    let to_regular = event(
        "EMPLOYMENT_TYPE_CHANGE",
        ClassificationChange {
            to_employment_type: Some("REGULAR".into()),
            ..ClassificationChange::default()
        },
    );
    let columns = classification_columns(&head, &to_regular);
    assert_eq!(columns.from_employment_type.as_deref(), Some("CONTRACT"));
    assert_eq!(columns.from_contract_start_date, head.contract_start_date);
    project_classification(&mut head, &to_regular);
    assert_eq!(head.employment_type.as_deref(), Some("REGULAR"));
    assert_eq!(
        (head.contract_start_date, head.contract_end_date),
        (None, None)
    );
    let mut back = event(
        "EMPLOYMENT_TYPE_CHANGE",
        ClassificationChange {
            to_employment_type: Some("CONTRACT".into()),
            ..ClassificationChange::default()
        },
    );
    back.contract_end_date = Some("2027-06-30".into());
    project_classification(&mut head, &back);
    assert_eq!(
        head.contract_start_date,
        parse_yyyy_mm_dd("2026-07-01").ok()
    );
    assert_eq!(head.contract_end_date, parse_yyyy_mm_dd("2027-06-30").ok());
}
