// SPDX-License-Identifier: LicenseRef-Proprietary
use super::tests::{CREATE, input};
use super::*;
use time::macros::date;
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

fn validate_with_reason(
    input: &WorkplaceInput,
    ctx: WorkplaceContext,
    today: time::Date,
) -> Result<WorkplaceDraft, Refusal> {
    let resolved = input
        .not_registered_reason
        .as_ref()
        .and_then(|reason| reason.code.as_deref())
        .and_then(|code| match code {
            "VAT_DEPOT" => Some(ResolvedReferenceCode {
                code: code.into(),
                label: "하치장".into(),
                list_key: "workplace_not_registered_reason".into(),
                version: "2026-10-22".into(),
                abstract_workplace: false,
            }),
            "REMOTE_TELEWORK" => Some(ResolvedReferenceCode {
                code: code.into(),
                label: "주소 없는 원격 근무지 묶음".into(),
                list_key: "workplace_not_registered_reason".into(),
                version: "2026-10-22".into(),
                abstract_workplace: true,
            }),
            _ => None,
        });
    validate_workplace_resolved(input, ctx, today, resolved.as_ref())
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
            version: Some("2026-10-22".into()),
        }),
        ..input()
    };
    let draft = validate_with_reason(&valid_abstract, CREATE, date!(2026 - 10 - 02)).unwrap();
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
    let err = validate_with_reason(&with_addr, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].field, "address");
    assert_eq!(err.fields[0].code, "not_applicable");

    // Negative: abstract with registration_id is refused
    let with_reg = WorkplaceInput {
        registration_id: Some(Uuid::from_u128(99)),
        ..valid_abstract
    };
    let err = validate_with_reason(&with_reg, CREATE, date!(2026 - 10 - 02)).unwrap_err();
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
            version: Some("2026-10-22".into()),
        }),
        ..input()
    };
    let draft = validate_with_reason(&valid_exempt, CREATE, date!(2026 - 10 - 02)).unwrap();
    assert_eq!(
        draft
            .not_registered_reason
            .as_ref()
            .map(|r| r.label.as_str()),
        Some("하치장")
    );

    // Negative 1: reg_mode NOT_REQUIRED without reason is refused
    let no_reason = WorkplaceInput {
        not_registered_reason: None,
        ..valid_exempt.clone()
    };
    let err = validate_with_reason(&no_reason, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].field, "not_registered_reason");
    assert_eq!(err.fields[0].code, "required");

    // Negative 2: invalid or unknown reason code is refused
    let invalid_reason = WorkplaceInput {
        not_registered_reason: Some(crate::legal_entity::CodeInput {
            code: Some("INVALID_STATUTE_CODE".into()),
            version: Some("2026-10-22".into()),
        }),
        ..valid_exempt.clone()
    };
    let err = validate_with_reason(&invalid_reason, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(err.fields[0].field, "not_registered_reason");
    assert_eq!(err.fields[0].code, "invalid_option");

    // Negative 3: NOT_REQUIRED with registration_id is refused
    let with_reg = WorkplaceInput {
        registration_id: Some(Uuid::from_u128(123)),
        ..valid_exempt
    };
    let err = validate_with_reason(&with_reg, CREATE, date!(2026 - 10 - 02)).unwrap_err();
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
            version: Some("2026-10-22".into()),
        }),
        ..input()
    };
    let err = validate_with_reason(&conflict, CREATE, date!(2026 - 10 - 02)).unwrap_err();
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
fn unknown_registration_mode_is_refused_instead_of_becoming_later() {
    let unknown = WorkplaceInput {
        reg_mode: Some("TYPO".into()),
        ..input()
    };
    let err = validate_workplace(&unknown, CREATE, date!(2026 - 10 - 02)).unwrap_err();
    assert_eq!(
        (err.fields[0].field.as_str(), err.fields[0].code),
        ("reg_mode", "invalid_option")
    );
}
