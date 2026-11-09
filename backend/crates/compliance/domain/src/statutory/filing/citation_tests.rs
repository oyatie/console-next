// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use super::{FilingRule, tests::rule};
use serde_json::{Value, json};

fn with_citations() -> Value {
    let mut value = serde_json::to_value(rule("NPS", "ACQUIRE")).unwrap();
    value["penalty"]["citation"] = value["citation"].clone();
    value["applicability_citations"] = json!([value["citation"], value["citation"]]);
    value
}

fn refuses_invalid_citation_urls(path: &str) {
    for bad in [
        "javascript:alert(1)",
        "http://www.law.go.kr/법령",
        "https://law.go.kr/법령",
        "https://www.law.go.kr.evil.test/법령",
        "https://www.law.go.kr@evil.test/법령",
        "https://www.law.go.kr/",
        "",
        "https://www.law.go.kr/법령 ",
        "https://www.law.go.kr/\t법령",
        "https://www.law.go.kr/법령\n",
        "https://www.law.go.kr/법령\u{7f}",
        "https://www.law.go.kr/법령\u{a0}",
    ] {
        let mut value = with_citations();
        *value.pointer_mut(path).unwrap() = json!(bad);
        let result = serde_json::from_value::<FilingRule>(value);
        assert!(result.is_err(), "{path} accepted {bad:?}");
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("filing_citation_source_url_invalid")
        );
    }
}

#[test]
fn primary_citation_urls_are_refused_at_deserialization() {
    refuses_invalid_citation_urls("/citation/source_url");
}

#[test]
fn penalty_citation_urls_are_refused_at_deserialization() {
    refuses_invalid_citation_urls("/penalty/citation/source_url");
}

#[test]
fn applicability_citation_urls_are_refused_at_deserialization() {
    refuses_invalid_citation_urls("/applicability_citations/1/source_url");
}

#[test]
fn valid_nested_citation_urls_keep_the_wire_shape() {
    let mut value = with_citations();
    value["applicability_citations"][1]["source_url"] =
        json!("https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=286165&efYd=20270101#article");
    let parsed: FilingRule = serde_json::from_value(value.clone()).unwrap();
    parsed.validate().unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
}
