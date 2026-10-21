use super::*;
use crate::codes::{VatUnitBasis, VatUnitMode};
use time::macros::date;

fn input() -> RegistrationInput {
    RegistrationInput {
        brn: Some("000-81-00009".into()),
        opened_on: Some("2020-03-02".into()),
        business_address: Some(AddressInput {
            source: Some("MANUAL_UNVERIFIED".into()),
            road_addr_part1: Some("서울특별시 강남구 테헤란로 152".into()),
            si_nm: Some("서울특별시".into()),
            sgg_nm: Some("강남구".into()),
            ..AddressInput::default()
        }),
        business_types: vec![BusinessTypeInput {
            is_main: Some(true),
            sector: Some("정보통신업".into()),
            item: Some("응용 소프트웨어 개발 및 공급업".into()),
            ..BusinessTypeInput::default()
        }],
        unit_taxation: Some(false),
        tax_office_label: Some("삼성세무서".into()),
        tax_type: Some("01".into()),
        ..RegistrationInput::default()
    }
}

const CTX: EntityContext<'static> = EntityContext {
    biz_kind: Some(BizKind::Corporation),
    entity_name: "주식회사 가나",
};

#[test]
fn the_registration_name_is_the_entitys_and_a_sent_one_is_ignored() {
    // regression (0h): the 등록증 ① showed its own copy while 수정 edited the entity's name.
    let mut json = serde_json::to_value(input()).unwrap();
    json["trade_name"] = "NURI".into();
    let sent: RegistrationInput = serde_json::from_value(json).unwrap();
    let (draft, warnings) = validate_registration(&sent, CTX, date!(2026 - 10 - 02)).unwrap();
    assert_eq!(draft.trade_name, None);
    assert!(warnings.is_empty());
}

#[test]
fn individual_registration_draft_retains_trade_name() {
    let ctx = EntityContext {
        biz_kind: Some(BizKind::Individual),
        entity_name: "가나상회",
    };
    let (draft, warnings) = validate_registration(&input(), ctx, date!(2026 - 10 - 02)).unwrap();
    assert_eq!(draft.trade_name, Some("가나상회".into()));
    assert!(warnings.is_empty());
}

#[test]
fn valid_certificate_has_no_warnings() {
    let (draft, warnings) = validate_registration(&input(), CTX, date!(2026 - 10 - 02)).unwrap();
    assert_eq!(draft.brn.unwrap().display(), "000-81-00009");
    assert_eq!(draft.tax_type, NtsTaxType::General);
    assert!(warnings.is_empty());
}

#[test]
fn pending_number_replaces_brn_and_unit_taxation_has_no_default() {
    let pending = RegistrationInput {
        brn: None,
        brn_pending_reason: Some("NEW_REGISTRATION_PENDING".into()),
        unit_taxation: None,
        ..input()
    };
    let err = validate_registration(&pending, CTX, date!(2026 - 10 - 02)).unwrap_err();
    let fields: Vec<_> = err
        .fields
        .iter()
        .map(|f| (f.field.as_str(), f.code))
        .collect();
    assert_eq!(fields, vec![("unit_taxation", "required")]);
}

#[test]
fn exactly_one_main_business_type_and_individual_only_co_owners() {
    let mut two_main = input();
    two_main
        .business_types
        .push(two_main.business_types[0].clone());
    two_main.co_owners = vec!["김철수".into()];
    let err = validate_registration(&two_main, CTX, date!(2026 - 10 - 02)).unwrap_err();
    let codes: Vec<_> = err.fields.iter().map(|f| f.code).collect();
    assert_eq!(codes, vec!["exactly_one_main", "not_applicable"]);
}

#[test]
fn checksum_is_a_warning() {
    let odd = RegistrationInput {
        brn: Some("000-81-00994".into()),
        ..input()
    };
    let (_, warnings) = validate_registration(&odd, CTX, date!(2026 - 10 - 02)).unwrap();
    let codes: Vec<_> = warnings.iter().map(|w| w.code).collect();
    assert_eq!(codes, vec!["brn_checksum_mismatch"]);
}

#[test]
fn vat_unit_mode_is_derived_until_it_matters() {
    use VatUnitBasis::*;
    assert_eq!(
        resolve_vat_unit_mode(None, 1, false).unwrap(),
        (VatUnitMode::PerWorkplace, SingleRegistration)
    );
    assert_eq!(
        resolve_vat_unit_mode(None, 1, true).unwrap(),
        (VatUnitMode::UnitTaxation, CertificateUnitTaxation)
    );
    let err = resolve_vat_unit_mode(None, 2, false).unwrap_err();
    assert_eq!(
        (err.fields[0].field.as_str(), err.remedy),
        ("vat_unit_mode", Some("declare_vat_unit_mode"))
    );
    assert!(resolve_vat_unit_mode(None, 2, true).is_err());
    assert_eq!(
        resolve_vat_unit_mode(Some(VatUnitMode::ConsolidatedPayment), 2, false).unwrap(),
        (VatUnitMode::ConsolidatedPayment, Declared)
    );
}

#[test]
fn the_unverified_reason_enum_is_exactly_the_table_check() {
    use crate::codes::UnverifiedReason;
    const MIGRATION: &str =
        include_str!("../../../platform/db/migrations/0257_legal_entities_and_workplaces.sql");
    let check = MIGRATION
        .lines()
        .find(|l| l.trim_start().starts_with("unverified_reason"))
        .expect("unverified_reason column");
    let listed: Vec<&str> = check.split('\'').skip(1).step_by(2).collect();
    let ours: Vec<&str> = UnverifiedReason::ALL.iter().map(|r| r.as_str()).collect();
    assert_eq!(listed, ours);
    assert_eq!(
        UnverifiedReason::parse("NOT_CHECKED"),
        Some(UnverifiedReason::NotChecked)
    );
}
