#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Pins what cargo-mutants found unpinned in entity-domain (TS-7,
//! tools/lanes/mutants.sh): every limit at its edge (the last accepted value
//! and the first refused one, with its code), the juso digit fields, the
//! document size and name limits, and that accepted values come back intact.

use console_entity_domain::address::{AddressInput, validate_address};
use console_entity_domain::document::{MAX_BYTES, validate_upload};
use console_entity_domain::legal_entity::{LegalEntityInput, validate_legal_entity};
use console_entity_domain::{Issues, Refusal};
use time::macros::date;

const TODAY: time::Date = date!(2026 - 10 - 07);

fn field_codes(r: &Refusal) -> Vec<(&str, &str)> {
    r.fields
        .iter()
        .map(|f| (f.field.as_str(), f.code))
        .collect()
}

#[test]
fn text_accepts_exactly_max_characters_and_refuses_one_more() {
    let mut is = Issues::default();
    assert!(is.is_empty());
    assert_eq!(
        is.text("name", Some(" 가나다 "), 3, true).as_deref(),
        Some("가나다")
    );
    assert!(is.is_empty());
    assert_eq!(is.text("name", Some("가나다라"), 3, true), None);
    assert_eq!(is.text("blank", Some("   "), 3, true), None);
    assert!(!is.is_empty());
    let codes: Vec<_> = is
        .into_vec()
        .into_iter()
        .map(|f| (f.field, f.code))
        .collect();
    assert_eq!(
        codes,
        [("name".into(), "too_long"), ("blank".into(), "required")]
    );
}

#[test]
fn a_date_on_its_latest_day_is_accepted_and_the_next_day_is_in_the_future() {
    let mut is = Issues::default();
    assert_eq!(
        is.date("d", Some("2026-10-07"), true, Some(TODAY)),
        Some(TODAY)
    );
    assert!(is.is_empty());
    assert_eq!(is.date("d", Some("2026-10-08"), true, Some(TODAY)), None);
    assert_eq!(is.date("e", Some("2026-02-30"), true, Some(TODAY)), None);
    let codes: Vec<_> = is.into_vec().into_iter().map(|f| f.code).collect();
    assert_eq!(codes, ["date_in_future", "date_invalid"]);
}

fn address(json: serde_json::Value) -> Result<(), Vec<(String, &'static str)>> {
    let input: AddressInput = serde_json::from_value(json).unwrap();
    let mut is = Issues::default();
    let ok = validate_address(&mut is, "a", &input).is_some();
    let issues: Vec<_> = is
        .into_vec()
        .into_iter()
        .map(|f| (f.field, f.code))
        .collect();
    if ok && issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

#[test]
fn juso_codes_must_be_exact_digit_runs_and_numbers_non_negative() {
    let base = serde_json::json!({
        "source": "JUSO", "road_addr_part1": "서울특별시 강남구 테헤란로 152", "si_nm": "서울특별시",
        "sgg_nm": "강남구", "zip_no": "06236", "adm_cd": "1168010100", "rn_mgt_sn": "116803122010",
        "bd_mgt_sn": "1168010100106480000000001", "buld_mnnm": 0, "buld_slno": 0,
    });
    assert_eq!(address(base.clone()), Ok(()));
    for (field, value) in [
        ("zip_no", "0623"),
        ("zip_no", "062366"),
        ("zip_no", "0623a"),
        ("adm_cd", "116801010"),
    ] {
        let mut bad = base.clone();
        bad[field] = value.into();
        assert_eq!(
            address(bad),
            Err(vec![(format!("a.{field}"), "invalid_option")]),
            "{field}={value}"
        );
    }
    for field in ["buld_mnnm", "buld_slno", "lnbr_mnnm", "lnbr_slno"] {
        let mut bad = base.clone();
        bad[field] = (-1).into();
        assert_eq!(
            address(bad),
            Err(vec![(format!("a.{field}"), "out_of_range")]),
            "{field}"
        );
    }
}

fn entity(patch: serde_json::Value) -> Result<(), Refusal> {
    let mut json = serde_json::json!({
        "biz_kind": "INDIVIDUAL", "name": "가나상회", "representation_mode": "SINGLE", "representatives": ["홍길동"],
    });
    json.as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    let input: LegalEntityInput = serde_json::from_value(json).unwrap();
    validate_legal_entity(&input, TODAY).map(|_| ())
}

#[test]
fn capital_is_non_negative_and_representatives_are_capped_at_50() {
    assert!(entity(serde_json::json!({ "capital_won": 0 })).is_ok());
    let negative = entity(serde_json::json!({ "capital_won": -1 })).unwrap_err();
    assert_eq!(field_codes(&negative), [("capital_won", "out_of_range")]);
    let names = |n: usize| (0..n).map(|i| format!("대표{i}")).collect::<Vec<_>>();
    assert!(
        entity(
            serde_json::json!({ "representation_mode": "SEVERAL", "representatives": names(50) })
        )
        .is_ok()
    );
    let over = entity(
        serde_json::json!({ "representation_mode": "SEVERAL", "representatives": names(51) }),
    )
    .unwrap_err();
    assert_eq!(field_codes(&over), [("representatives", "out_of_range")]);
}

#[test]
fn the_validated_representatives_are_the_names_given() {
    let input: LegalEntityInput = serde_json::from_value(serde_json::json!({
        "biz_kind": "INDIVIDUAL", "name": "가나상회", "representation_mode": "SEVERAL", "representatives": [" 홍길동 ", "김철수"],
    }))
    .unwrap();
    let (draft, _) = validate_legal_entity(&input, TODAY).unwrap();
    assert_eq!(draft.representatives, ["홍길동", "김철수"]);
}

#[test]
fn an_upload_is_at_most_10_mib_and_its_name_at_most_255_characters() {
    assert_eq!(MAX_BYTES, 10 * 1024 * 1024);
    let pdf = |len: usize| {
        let mut b = b"%PDF-1.7\n".to_vec();
        b.resize(len, b' ');
        b
    };
    assert!(validate_upload(Some("OTHER"), Some("a.pdf"), pdf(MAX_BYTES)).is_ok());
    let big = validate_upload(Some("OTHER"), Some("a.pdf"), pdf(MAX_BYTES + 1)).unwrap_err();
    assert_eq!(field_codes(&big), [("file", "file_too_large")]);
    let name = |n: usize| format!("{}.pdf", "가".repeat(n - 4));
    assert!(validate_upload(Some("OTHER"), Some(&name(255)), pdf(64)).is_ok());
    let long = validate_upload(Some("OTHER"), Some(&name(256)), pdf(64)).unwrap_err();
    assert_eq!(field_codes(&long), [("file_name", "too_long")]);
}
