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
