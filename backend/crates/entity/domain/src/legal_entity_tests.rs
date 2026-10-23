use super::*;
use time::macros::date;

fn corp() -> LegalEntityInput {
    LegalEntityInput {
        biz_kind: Some("CORPORATION".into()),
        name: Some("주식회사 가나".into()),
        representation_mode: Some("SINGLE".into()),
        representatives: vec!["홍길동".into()],
        crn: Some("000211-0006241".into()),
        head_office_address: Some(AddressInput {
            source: Some("MANUAL_UNVERIFIED".into()),
            road_addr_part1: Some("서울특별시 강남구 테헤란로 152".into()),
            si_nm: Some("서울특별시".into()),
            sgg_nm: Some("강남구".into()),
            ..AddressInput::default()
        }),
        ..LegalEntityInput::default()
    }
}

fn fields(r: Refusal) -> Vec<(String, &'static str)> {
    r.fields.into_iter().map(|f| (f.field, f.code)).collect()
}

#[test]
fn corporation_needs_crn_and_head_office() {
    let today = date!(2026 - 10 - 02);
    let (draft, warnings) = validate_legal_entity(&corp(), today).unwrap();
    assert_eq!(draft.crn.unwrap().as_str(), "0002110006241");
    assert!(warnings.is_empty());
    let bare = LegalEntityInput {
        crn: None,
        head_office_address: None,
        ..corp()
    };
    let refused = fields(validate_legal_entity(&bare, today).unwrap_err());
    assert_eq!(
        refused,
        vec![
            ("crn".into(), "required"),
            ("head_office_address".into(), "required")
        ]
    );
}

#[test]
fn no_default_for_kind_or_representation() {
    let input = LegalEntityInput {
        biz_kind: None,
        representation_mode: None,
        ..corp()
    };
    let refused = fields(validate_legal_entity(&input, date!(2026 - 10 - 02)).unwrap_err());
    assert!(refused.contains(&("biz_kind".into(), "required")));
    assert!(refused.contains(&("representation_mode".into(), "required")));
}

#[test]
fn joint_representation_needs_two_including_unnamed() {
    let today = date!(2026 - 10 - 02);
    let joint = LegalEntityInput {
        representation_mode: Some("JOINT".into()),
        ..corp()
    };
    let refused = fields(validate_legal_entity(&joint, today).unwrap_err());
    assert_eq!(
        refused,
        vec![(
            "representation_mode".into(),
            "representation_count_mismatch"
        )]
    );
    // 「홍길동 외 1명」: one name printed, one more counted.
    let printed = LegalEntityInput {
        additional_representatives: Some(1),
        ..joint
    };
    assert!(validate_legal_entity(&printed, today).is_ok());
}

#[test]
fn individual_refuses_crn_and_warns_checksum_only_for_old_corporations() {
    let today = date!(2026 - 10 - 02);
    let individual = LegalEntityInput {
        biz_kind: Some("INDIVIDUAL".into()),
        ..corp()
    };
    let refused = fields(validate_legal_entity(&individual, today).unwrap_err());
    assert_eq!(refused, vec![("crn".into(), "not_applicable")]);
    let old = LegalEntityInput {
        crn: Some("000211-0006242".into()),
        incorporated_on: Some("1969-01-13".into()),
        ..corp()
    };
    let (_, warnings) = validate_legal_entity(&old, today).unwrap();
    assert_eq!(warnings[0].code, "crn_checksum_mismatch");
    let new = LegalEntityInput {
        incorporated_on: Some("2025-03-01".into()),
        ..old
    };
    assert!(validate_legal_entity(&new, today).unwrap().1.is_empty());
}

#[test]
fn future_incorporation_and_bad_month_refused() {
    let input = LegalEntityInput {
        incorporated_on: Some("2027-01-01".into()),
        fiscal_year_end_month: Some(13),
        ..corp()
    };
    let refused = fields(validate_legal_entity(&input, date!(2026 - 10 - 02)).unwrap_err());
    assert_eq!(
        refused,
        vec![
            ("incorporated_on".into(), "date_in_future"),
            ("fiscal_year_end_month".into(), "out_of_range")
        ]
    );
}

#[test]
fn a_ksic_code_is_taken_alone_and_stamped_unverified() {
    let today = date!(2026 - 10 - 02);
    // INTEG-4: a client-sent label or version is not accepted as fact.
    let input: LegalEntityInput = serde_json::from_value(serde_json::json!({
        "main_ksic": { "code": "j62010", "label": "아무거나", "version": "x" }
    }))
    .unwrap();
    let input = LegalEntityInput {
        main_ksic: input.main_ksic,
        ..corp()
    };
    let (draft, _) = validate_legal_entity(&input, today).unwrap();
    let ksic = draft.main_ksic.unwrap();
    assert_eq!(
        (
            ksic.code.as_str(),
            ksic.label.as_str(),
            ksic.version.as_str()
        ),
        ("J62010", "J62010", CODE_UNVERIFIED)
    );
    let bad = LegalEntityInput {
        main_ksic: Some(CodeInput {
            code: Some("62-01".into()),
            version: None,
        }),
        ..corp()
    };
    let refusal = validate_legal_entity(&bad, today).unwrap_err();
    assert_eq!(
        fields(refusal),
        vec![("main_ksic.code".into(), "invalid_option")]
    );
}
