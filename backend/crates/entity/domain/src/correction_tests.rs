use super::*;
use time::macros::date;

fn fields(r: Refusal) -> Vec<(String, &'static str)> {
    r.fields.into_iter().map(|f| (f.field, f.code)).collect()
}

fn crn_fix() -> IdentifierCorrectionInput {
    IdentifierCorrectionInput {
        field: Some("crn".into()),
        value: Some("000211-0006241".into()),
        document_id: Some(Uuid::nil()),
        reason_code: Some("REGISTRY_DIFFERS".into()),
        exception_id: None,
        ..IdentifierCorrectionInput::default()
    }
}

#[test]
fn correction_is_canonical_and_needs_evidence() {
    let ok = validate_correction(&crn_fix(), false).unwrap();
    assert_eq!(ok.field, IdentifierField::Crn);
    assert_eq!(ok.value, "0002110006241");
    assert_eq!(ok.governed_payload().value, "0002110006241");

    let bare = IdentifierCorrectionInput {
        document_id: None,
        reason_code: Some("BECAUSE".into()),
        ..crn_fix()
    };
    assert_eq!(
        fields(validate_correction(&bare, false).unwrap_err()),
        vec![
            ("document_id".into(), "required"),
            ("reason_code".into(), "invalid_option"),
        ]
    );
}

#[test]
fn field_must_match_the_record() {
    let brn_on_entity = IdentifierCorrectionInput {
        field: Some("brn".into()),
        value: Some("0008162515".into()),
        ..crn_fix()
    };
    assert_eq!(
        fields(validate_correction(&brn_on_entity, false).unwrap_err()),
        vec![("field".into(), "not_applicable")]
    );
    let fixed = validate_correction(&brn_on_entity, true).unwrap();
    assert_eq!(fixed.value, "0008162515");
    assert!(validate_correction(&crn_fix(), true).is_err());

    let kind = IdentifierCorrectionInput {
        field: Some("biz_kind".into()),
        value: Some("INDIVIDUAL".into()),
        ..crn_fix()
    };
    assert_eq!(
        validate_correction(&kind, false).unwrap().value,
        "INDIVIDUAL"
    );
}

#[test]
fn registration_change_serial_follows_the_target() {
    let today = date!(2026 - 10 - 06);
    let input = RegistrationChangeInput {
        registration_id: Some(Uuid::nil()),
        sub_serial: Some("0002".into()),
        effective_from: Some("2026-10-01".into()),
        reason_code: Some("UNIT_TAXATION".into()),
    };
    let ok = validate_registration_change(&input, true, today).unwrap();
    assert_eq!(ok.sub_serial.unwrap().as_str(), "0002");
    assert_eq!(
        fields(validate_registration_change(&input, false, today).unwrap_err()),
        vec![("sub_serial".into(), "not_applicable")]
    );
    let no_serial = RegistrationChangeInput {
        sub_serial: None,
        ..input.clone()
    };
    assert_eq!(
        fields(validate_registration_change(&no_serial, true, today).unwrap_err()),
        vec![("sub_serial".into(), "required")]
    );
    let future = RegistrationChangeInput {
        effective_from: Some("2026-10-07".into()),
        ..input
    };
    assert_eq!(
        fields(validate_registration_change(&future, true, today).unwrap_err()),
        vec![("effective_from".into(), "date_in_future")]
    );
}

#[test]
fn reissue_needs_the_new_certificate_a_reason_and_past_dates() {
    let today = date!(2026 - 10 - 14);
    let ok = ReissueInput {
        document_id: Some(Uuid::nil()),
        reason: Some("CERT_CHANGE_REPORT".into()),
        effective_from: Some("2026-10-01".into()),
    };
    let r = validate_reissue(&ok, Some("2026-10-02"), today).unwrap();
    assert_eq!(r.reason, CertificateRevisionReason::ChangeReport);
    assert_eq!(r.effective_from, date!(2026 - 10 - 01));

    assert_eq!(
        fields(validate_reissue(&ReissueInput::default(), None, today).unwrap_err()),
        vec![
            ("document_id".into(), "required"),
            ("reason".into(), "required"),
            ("effective_from".into(), "required"),
            ("cert_issued_on".into(), "required"),
        ]
    );
    let later = ReissueInput {
        reason: Some("CHANGE".into()),
        effective_from: Some("2026-10-15".into()),
        ..ok
    };
    assert_eq!(
        fields(validate_reissue(&later, Some("2026-10-15"), today).unwrap_err()),
        vec![
            ("reason".into(), "invalid_option"),
            ("effective_from".into(), "date_in_future"),
            ("cert_issued_on".into(), "date_in_future"),
        ]
    );
}
