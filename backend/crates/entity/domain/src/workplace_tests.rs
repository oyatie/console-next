use super::*;
use crate::insurance::InsurerInput;
use time::macros::date;

fn input() -> WorkplaceInput {
    WorkplaceInput {
        name: Some("본사".into()),
        registration_id: Some(Uuid::from_u128(7)),
        same_address_as_registration: true,
        opened_on: Some("2020-03-02".into()),
        phone: Some("02-123-4567".into()),
        insurance: Some(InsuranceSetupInput {
            shortcut: Some("ALL_ESTABLISHED_NUMBERS_LATER".into()),
            insurers: vec![],
        }),
        ..WorkplaceInput::default()
    }
}

const CREATE: WorkplaceContext = WorkplaceContext {
    biz_kind: Some(BizKind::Corporation),
    registration_is_unit_taxation_of_other: false,
    creating: true,
};

#[test]
fn one_click_primary_workplace_from_the_certificate() {
    let draft = validate_workplace(&input(), CREATE, date!(2026 - 10 - 02)).unwrap();
    assert_eq!(draft.address, WorkplaceAddress::SameAsRegistration);
    assert_eq!(draft.phone.unwrap().display(), "02-123-4567");
    assert_eq!(draft.insurance.len(), 4);
    assert!(
        draft
            .insurance
            .iter()
            .all(|i| i.status == crate::codes::InsuranceStatus::EstablishedNumberPending)
    );
}

#[test]
fn insurance_choice_has_no_default_and_established_needs_numbers() {
    let none = WorkplaceInput {
        insurance: None,
        ..input()
    };
    let err = validate_workplace(&none, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].field, "insurance");
    let now = WorkplaceInput {
        insurance: Some(InsuranceSetupInput {
            shortcut: Some("ALL_ESTABLISHED_NOW".into()),
            insurers: vec![InsurerInput {
                insurer: Some("NPS".into()),
                ..InsurerInput::default()
            }],
        }),
        ..input()
    };
    let err = validate_workplace(&now, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    let fields: Vec<_> = err.fields.iter().map(|f| f.field.as_str()).collect();
    assert_eq!(
        fields,
        vec![
            "insurance.insurers[0].mgmt_no",
            "insurance.insurers[0].established_on",
            "insurance.insurers.NHIS",
            "insurance.insurers.EI",
            "insurance.insurers.IACI",
        ]
    );
}

#[test]
fn sub_serial_only_under_unit_taxation_of_another_holder() {
    let with_serial = WorkplaceInput {
        sub_serial: Some("0001".into()),
        ..input()
    };
    let err = validate_workplace(&with_serial, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].code, "not_applicable");
    let ctx = WorkplaceContext {
        registration_is_unit_taxation_of_other: true,
        ..CREATE
    };
    let err = validate_workplace(&input(), ctx, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(
        (err.fields[0].field.as_str(), err.fields[0].code),
        ("sub_serial", "required")
    );
    assert!(validate_workplace(&with_serial, ctx, date!(2026 - 10 - 02)).is_ok());
}

#[test]
fn lsa_declaration_needs_evidence_and_bulk_needs_its_date() {
    let lsa = WorkplaceInput {
        independent_lsa_unit: Some(true),
        withholding_mode: Some("HEAD_OFFICE_BULK".into()),
        ..input()
    };
    let err = validate_workplace(&lsa, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    let fields: Vec<_> = err.fields.iter().map(|f| f.field.as_str()).collect();
    assert_eq!(fields, vec!["bulk_filed_on", "independent_lsa_evidence"]);
}

#[test]
fn withholding_follows_statute_for_a_corporation() {
    let me = Uuid::from_u128(1);
    let head = Uuid::from_u128(2);
    let facts = WithholdingFacts {
        biz_kind: Some(BizKind::Corporation),
        mode: None,
        this_workplace: me,
        head_office_workplace: Some(head),
        head_office_has_no_workplace: false,
    };
    assert_eq!(
        withholding_target(facts),
        WithholdingTarget::Workplace {
            workplace_id: head,
            basis: "income_tax_act_7_1_3"
        }
    );
    let own = WithholdingFacts {
        mode: Some(WithholdingMode::OwnIndependentAccounts),
        ..facts
    };
    assert_eq!(
        withholding_target(own),
        WithholdingTarget::SelfUnit {
            basis: "income_tax_act_7_1_4"
        }
    );
    let office_only = WithholdingFacts {
        head_office_workplace: None,
        head_office_has_no_workplace: true,
        ..facts
    };
    assert!(matches!(
        withholding_target(office_only),
        WithholdingTarget::EntityHeadOffice { .. }
    ));
    let unknown = WithholdingFacts {
        head_office_workplace: None,
        ..facts
    };
    assert_eq!(
        withholding_target(unknown),
        WithholdingTarget::Undecided {
            remedy: "set_head_office_workplace"
        }
    );
    let individual = WithholdingFacts {
        biz_kind: Some(BizKind::Individual),
        ..facts
    };
    assert_eq!(
        withholding_target(individual),
        WithholdingTarget::Undecided {
            remedy: "choose_withholding_mode"
        }
    );
}

fn valid_address() -> AddressInput {
    AddressInput {
        source: Some("MANUAL_UNVERIFIED".into()),
        road_addr_part1: Some("서울특별시 강남구 테헤란로 152".into()),
        si_nm: Some("서울특별시".into()),
        sgg_nm: Some("강남구".into()),
        detail: Some("12층".into()),
        ..AddressInput::default()
    }
}

#[test]
fn abstract_workplace_needs_no_address_and_refuses_registration_or_address() {
    let valid_abstract = WorkplaceInput {
        registration_id: None,
        same_address_as_registration: false,
        address: None,
        is_abstract: Some(true),
        reg_mode: Some("NOT_REQUIRED".into()),
        not_registered_reason: Some(crate::legal_entity::CodeInput {
            code: Some("REMOTE_TELEWORK".into()),
        }),
        ..input()
    };
    let draft = validate_workplace(&valid_abstract, CREATE, date!(2026 - 10 - 02)).unwrap();
    assert_eq!(draft.address, WorkplaceAddress::None);
    assert!(draft.is_abstract);
    assert_eq!(
        draft
            .not_registered_reason
            .as_ref()
            .map(|r| r.code.as_str()),
        Some("REMOTE_TELEWORK")
    );

    // Negative: abstract with address is refused
    let with_addr = WorkplaceInput {
        address: Some(valid_address()),
        ..valid_abstract.clone()
    };
    let err = validate_workplace(&with_addr, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].field, "address");
    assert_eq!(err.fields[0].code, "not_applicable");

    // Negative: abstract with registration_id is refused
    let with_reg = WorkplaceInput {
        registration_id: Some(Uuid::from_u128(99)),
        ..valid_abstract
    };
    let err = validate_workplace(&with_reg, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    let fields: Vec<_> = err
        .fields
        .iter()
        .map(|f| (f.field.as_str(), f.code))
        .collect();
    assert!(fields.contains(&("registration_id", "not_applicable")));
}

#[test]
fn not_required_reg_mode_requires_valid_statutory_reason() {
    let valid_exempt = WorkplaceInput {
        registration_id: None,
        same_address_as_registration: false,
        address: Some(valid_address()),
        is_abstract: Some(false),
        reg_mode: Some("NOT_REQUIRED".into()),
        not_registered_reason: Some(crate::legal_entity::CodeInput {
            code: Some("VAT_DEPOT".into()),
        }),
        ..input()
    };
    let draft = validate_workplace(&valid_exempt, CREATE, date!(2026 - 10 - 02)).unwrap();
    assert_eq!(
        draft
            .not_registered_reason
            .as_ref()
            .map(|r| r.label.as_str()),
        Some("하치장 (재화 보관·관리 장소)")
    );

    // Negative 1: reg_mode NOT_REQUIRED without reason is refused
    let no_reason = WorkplaceInput {
        not_registered_reason: None,
        ..valid_exempt.clone()
    };
    let err = validate_workplace(&no_reason, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].field, "not_registered_reason");
    assert_eq!(err.fields[0].code, "required");

    // Negative 2: invalid or unknown reason code is refused
    let invalid_reason = WorkplaceInput {
        not_registered_reason: Some(crate::legal_entity::CodeInput {
            code: Some("INVALID_STATUTE_CODE".into()),
        }),
        ..valid_exempt.clone()
    };
    let err = validate_workplace(&invalid_reason, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].field, "not_registered_reason");
    assert_eq!(err.fields[0].code, "invalid_option");

    // Negative 3: NOT_REQUIRED with registration_id is refused
    let with_reg = WorkplaceInput {
        registration_id: Some(Uuid::from_u128(123)),
        ..valid_exempt
    };
    let err = validate_workplace(&with_reg, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    let fields: Vec<_> = err
        .fields
        .iter()
        .map(|f| (f.field.as_str(), f.code))
        .collect();
    assert!(fields.contains(&("registration_id", "not_applicable")));
}

#[test]
fn not_registered_reason_with_registration_is_refused() {
    let conflict = WorkplaceInput {
        registration_id: Some(Uuid::from_u128(42)),
        not_registered_reason: Some(crate::legal_entity::CodeInput {
            code: Some("VAT_DEPOT".into()),
        }),
        ..input()
    };
    let err = validate_workplace(&conflict, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].field, "not_registered_reason");
    assert_eq!(err.fields[0].code, "not_applicable");
}

#[test]
fn physical_workplace_without_registration_still_requires_address() {
    let unreg_no_addr = WorkplaceInput {
        registration_id: None,
        same_address_as_registration: false,
        address: None,
        is_abstract: Some(false),
        ..input()
    };
    let err = validate_workplace(&unreg_no_addr, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].field, "address");
    assert_eq!(err.fields[0].code, "required");
}

#[test]
fn derive_filing_registration_returns_expected() {
    use crate::workplace_registration::{WorkplaceRegistrationAnswer, derive_filing_registration};

    let primary_reg = Some(Uuid::from_u128(100));
    let own_reg = Uuid::from_u128(200);

    let reg_ans = WorkplaceRegistrationAnswer::Registered {
        registration_id: own_reg,
        sub_serial: None,
    };
    assert_eq!(
        derive_filing_registration(primary_reg, &reg_ans),
        Some(own_reg)
    );

    let not_req_ans = WorkplaceRegistrationAnswer::NotRequired {
        reason: crate::legal_entity::CodeRef {
            code: "VAT_DEPOT".into(),
            label: "하치장".into(),
            version: "2026-10-21".into(),
        },
    };
    assert_eq!(
        derive_filing_registration(primary_reg, &not_req_ans),
        primary_reg
    );

    let later_ans = WorkplaceRegistrationAnswer::Later;
    assert_eq!(
        derive_filing_registration(primary_reg, &later_ans),
        primary_reg
    );
}
