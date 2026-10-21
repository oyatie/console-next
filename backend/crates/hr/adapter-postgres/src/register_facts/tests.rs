#![allow(clippy::unwrap_used, clippy::expect_used)]
use console_hr_domain::register::exit_reason_label;
use serde_json::json;

use super::*;

#[test]
fn every_system_exit_reason_has_a_register_label() {
    for code in ReasonDomain::ExitReason.system_codes() {
        assert!(
            exit_reason_label(code.code).is_some(),
            "no register label for exit_reason {}",
            code.code
        );
    }
}

#[test]
fn stored_text_normalizes_to_itself() {
    let address = json!({
        "source": "MANUAL_UNVERIFIED",
        "road_addr_part1": "서울특별시 강남구 테헤란로 152",
        "si_nm": "서울특별시",
        "sgg_nm": "강남구",
        "detail": "12층",
    });
    let careers = json!([{ "employer_name": "가나상사", "from": "2019-03", "to": "2021-12" }]);
    for (field, value) in [
        ("sex", json!("female")),
        ("exit_reason", json!("CONTRACT_END")),
        ("register_note", json!(" 비고 ")),
        ("address", address),
        ("careers", careers),
        ("careers", json!([])),
    ] {
        let stored = normalize(field, &value).unwrap().expect(field);
        assert_eq!(
            normalize(field, &Value::String(stored.clone())).unwrap(),
            Some(stored),
            "{field}"
        );
    }
}

#[test]
fn null_clears_except_the_exit_reason_and_ledgers_as_null() {
    for field in ["sex", "address", "careers", "register_note"] {
        assert_eq!(normalize(field, &Value::Null).unwrap(), None);
        assert_eq!(ledger_value(field, None), Value::Null);
    }
    assert!(normalize("exit_reason", &Value::Null).is_err());
    assert_eq!(ledger_value("careers", Some("[]")), json!([]));
    assert_eq!(ledger_value("sex", Some("MALE")), json!("MALE"));
}

#[test]
fn bad_values_are_refused() {
    assert!(normalize("sex", &json!("남")).is_err());
    assert!(normalize("exit_reason", &json!("FIRED")).is_err());
    assert!(normalize("address", &json!({ "source": "MANUAL_UNVERIFIED" })).is_err());
    assert!(
        normalize(
            "careers",
            &json!([{ "employer_name": "가", "from": "2019" }])
        )
        .is_err()
    );
    assert!(normalize("careers", &json!([{ "employer": "가", "from": "2019-01" }])).is_err());
    assert!(normalize("phone", &json!("010")).is_err());
}
