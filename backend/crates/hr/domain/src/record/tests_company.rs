//! MR-33 / MR-35 section rules.

use serde_json::json;
use time::macros::date;

use super::*;

fn disability(raw: serde_json::Value) -> Result<RecordFields, String> {
    let v: Disability = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    RecordFields::Disability(v)
        .validate()
        .map_err(|e| e.message)
}

#[test]
fn every_section_round_trips_its_segment_and_code() {
    for s in Section::ALL {
        assert_eq!(Section::from_segment(s.segment()).unwrap(), *s);
        assert_eq!(Section::parse(s.as_str()).unwrap(), *s);
    }
    let restricted: Vec<_> = Section::ALL.iter().filter(|s| s.restricted()).collect();
    assert_eq!(
        restricted,
        [
            &Section::Discipline,
            &Section::Disability,
            &Section::Veteran
        ]
    );
    assert!(Section::Disability.single_live() && Section::Veteran.single_live());
    assert!(!Section::Discipline.single_live() && !Section::Family.single_live());
}

#[test]
fn language_is_an_iso_code_and_dates_are_ordered() {
    let lang = |code: &str, expires| Language {
        language: code.into(),
        test: Some(" TOEIC ".into()),
        score: Some("900".into()),
        taken_on: Some(date!(2025 - 01 - 10)),
        expires_on: expires,
    };
    let RecordFields::Language(v) = RecordFields::Language(lang(" EN ", None))
        .validate()
        .unwrap()
    else {
        panic!("section changed");
    };
    assert_eq!(
        (v.language.as_str(), v.test.as_deref()),
        ("en", Some("TOEIC"))
    );
    for bad in ["e", "engl", "e1", "영어"] {
        assert!(
            RecordFields::Language(lang(bad, None)).validate().is_err(),
            "{bad}"
        );
    }
    let early = lang("ja", Some(date!(2024 - 01 - 01)));
    assert!(RecordFields::Language(early).validate().is_err());
}

#[test]
fn award_and_discipline_need_a_title_and_an_ordered_period() {
    let award = Award {
        title: "  ".into(),
        decided_on: date!(2025 - 03 - 01),
        issuer: None,
        details: None,
    };
    assert!(RecordFields::Award(award).validate().is_err());
    let discipline = Discipline {
        title: "정직".into(),
        decided_on: date!(2025 - 03 - 01),
        issuer: Some("징계위원회".into()),
        details: None,
        ends_on: Some(date!(2025 - 02 - 01)),
    };
    assert!(
        RecordFields::Discipline(discipline.clone())
            .validate()
            .is_err()
    );
    let ok = Discipline {
        ends_on: Some(date!(2025 - 03 - 31)),
        ..discipline
    };
    assert!(RecordFields::Discipline(ok).validate().is_ok());
}

#[test]
fn a_family_member_is_never_stored_with_a_resident_number() {
    let family = Family {
        relation: FamilyRelation::Child,
        name: "홍길동 900101-1234567".into(),
        birth_date: None,
        cohabiting: Some(true),
    };
    assert!(RecordFields::Family(family).validate().is_err());
    let unknown = json!({ "relation": "CHILD", "name": "홍길동", "rrn": "x" });
    assert!(serde_json::from_value::<Family>(unknown).is_err());
}

#[test]
fn a_restricted_entry_carries_a_basis_that_covers_its_section() {
    let consent = json!({ "severity": "SEVERE",
        "basis": { "kind": "CONSENT", "consent_on": "2026-01-02" } });
    assert!(disability(consent).is_ok());
    let statute = json!({ "severity": "NON_SEVERE",
        "basis": { "kind": "STATUTE", "statute": "DISABLED_EMPLOYMENT" } });
    assert!(disability(statute).is_ok());
    for bad in [
        json!({ "severity": "SEVERE" }),
        json!({ "severity": "SEVERE", "basis": { "kind": "CONSENT" } }),
        json!({ "severity": "SEVERE", "basis": { "kind": "STATUTE", "statute": "VETERAN_EMPLOYMENT" } }),
        json!({ "severity": "SEVERE", "basis": { "kind": "CONSENT", "consent_on": "2026-01-02", "statute": "DISABLED_EMPLOYMENT" } }),
        json!({ "severity": "SEVERE", "kind_of_disability": "x",
            "basis": { "kind": "CONSENT", "consent_on": "2026-01-02" } }),
    ] {
        assert!(disability(bad.clone()).is_err(), "{bad}");
    }
    let veteran: Veteran = serde_json::from_value(json!({ "target": "SELF",
        "basis": { "kind": "STATUTE", "statute": "DISABLED_EMPLOYMENT" } }))
    .unwrap();
    assert!(RecordFields::Veteran(veteran).validate().is_err());
}
