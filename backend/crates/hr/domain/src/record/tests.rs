use time::macros::date;
use uuid::Uuid;

use super::plan::{Decision, EntryFact, RowIntent, decide};
use super::*;

fn qual(kind: QualKind, number: Option<&str>) -> Qualification {
    Qualification {
        name: " 정보처리기사 ".into(),
        kind,
        grade: Some(String::new()),
        issuer: None,
        number: number.map(str::to_owned),
        acquired_on: Some(date!(2020 - 05 - 01)),
        expires_on: None,
    }
}

#[test]
fn text_is_trimmed_and_empty_optionals_drop() {
    let RecordFields::Qualification(v) =
        RecordFields::Qualification(qual(QualKind::NationalTechnical, None))
            .validate()
            .unwrap()
    else {
        panic!("section changed");
    };
    assert_eq!(v.name, "정보처리기사");
    assert_eq!(v.grade, None);
}

#[test]
fn identifiers_are_refused_in_free_text() {
    let mut q = qual(QualKind::Private, None);
    q.issuer = Some("900101-1234567".into());
    assert!(RecordFields::Qualification(q).validate().is_err());
    let mut e = Education {
        school: "한국대학교".into(),
        level: EduLevel::Bachelor,
        major: Some("외국인 9001015234567".into()),
        status: EduStatus::Graduated,
        entered_on: None,
        ended_on: None,
    };
    assert!(RecordFields::Education(e.clone()).validate().is_err());
    e.major = Some("경영학".into());
    assert!(RecordFields::Education(e).validate().is_ok());
}

#[test]
fn driver_licence_numbers_are_never_stored() {
    for (kind, number) in [
        (QualKind::DriverLicense, "A-123"),
        (QualKind::Other, "11-23-456789-01"),
        (QualKind::Private, "112345678901"),
        (QualKind::Other, "서울 23-456789-01"),
        (QualKind::Foreign, "M12345678"),
        (QualKind::Foreign, "M123A4567"),
    ] {
        let q = qual(kind, Some(number));
        assert!(
            RecordFields::Qualification(q).validate().is_err(),
            "{number}"
        );
    }
    let ok = qual(QualKind::NationalTechnical, Some("20201234567Q"));
    assert!(RecordFields::Qualification(ok).validate().is_ok());
    let licence = qual(QualKind::DriverLicense, None);
    assert!(RecordFields::Qualification(licence).validate().is_ok());
}

#[test]
fn military_details_only_when_served_and_dates_ordered() {
    let exempt = Military {
        status: MilStatus::Exempt,
        branch: Some(MilBranch::Army),
        rank: None,
        served_from: None,
        served_to: None,
    };
    assert!(RecordFields::Military(exempt).validate().is_err());
    let done = Military {
        status: MilStatus::Completed,
        branch: Some(MilBranch::Army),
        rank: Some("병장".into()),
        served_from: Some(date!(2015 - 03 - 02)),
        served_to: Some(date!(2014 - 12 - 01)),
    };
    assert!(RecordFields::Military(done.clone()).validate().is_err());
    let done = Military {
        served_to: Some(date!(2016 - 12 - 01)),
        ..done
    };
    assert!(RecordFields::Military(done).validate().is_ok());
}

#[test]
fn education_is_month_precision_and_training_hours_bounded() {
    let e = Education {
        school: "고등학교".into(),
        level: EduLevel::HighSchool,
        major: None,
        status: EduStatus::Graduated,
        entered_on: Some(date!(2010 - 03 - 15)),
        ended_on: Some(date!(2013 - 02 - 10)),
    };
    let RecordFields::Education(e) = RecordFields::Education(e).validate().unwrap() else {
        panic!("section changed");
    };
    assert_eq!(e.entered_on, Some(date!(2010 - 03 - 01)));
    let t = Training {
        course: "산업안전보건교육".into(),
        provider: None,
        status: TrainStatus::Completed,
        started_on: date!(2026 - 01 - 05),
        ended_on: None,
        hours: Some(0),
    };
    assert!(RecordFields::Training(t).validate().is_err());
}

#[test]
fn wire_shape_rejects_unknown_fields_and_parses_dates() {
    let ok: Military = serde_json::from_str(r#"{"status":"NOT_APPLICABLE"}"#).unwrap();
    assert_eq!(ok.status, MilStatus::NotApplicable);
    assert!(
        serde_json::from_str::<Military>(r#"{"status":"EXEMPT","exemption_reason":"x"}"#).is_err()
    );
    let t: Training =
        serde_json::from_str(r#"{"course":"c","status":"COMPLETED","started_on":"2026-01-05"}"#)
            .unwrap();
    assert_eq!(t.started_on, date!(2026 - 01 - 05));
    assert_eq!(
        Section::from_segment("military").unwrap(),
        Section::Military
    );
    assert!(Section::from_segment("hobby").is_err());
}

fn fact(person: Uuid, section: Section, fields: RecordFields, voided: bool) -> EntryFact {
    EntryFact {
        entry_id: Uuid::new_v4(),
        person_id: person,
        section,
        version: 2,
        voided,
        fields,
    }
}

fn mil(status: MilStatus) -> RecordFields {
    RecordFields::Military(Military {
        status,
        branch: None,
        rank: None,
        served_from: None,
        served_to: None,
    })
}

#[test]
fn import_rows_dedupe_upsert_military_and_check_targets() {
    let person = Uuid::new_v4();
    let s = Section::Military;
    let live = [fact(person, s, mil(MilStatus::NotCompleted), false)];
    let id = live[0].entry_id;
    assert_eq!(
        decide(
            s,
            person,
            &RowIntent::Create(mil(MilStatus::NotCompleted)),
            None,
            &live
        ),
        Decision::Unchanged { entry_id: id }
    );
    assert_eq!(
        decide(
            s,
            person,
            &RowIntent::Create(mil(MilStatus::Completed)),
            None,
            &live
        ),
        Decision::Update {
            entry_id: id,
            version: 2
        }
    );
    let update = |v| RowIntent::Update {
        entry_id: id,
        expected_version: v,
        fields: mil(MilStatus::Exempt),
    };
    assert_eq!(
        decide(s, person, &update(Some(1)), Some(&live[0]), &live),
        Decision::Error {
            code: "version_conflict"
        }
    );
    assert_eq!(
        decide(s, Uuid::new_v4(), &update(None), Some(&live[0]), &live),
        Decision::Error {
            code: "entry_not_found"
        }
    );
    let voided = EntryFact {
        voided: true,
        ..live[0].clone()
    };
    assert_eq!(
        decide(
            s,
            person,
            &RowIntent::Void {
                entry_id: id,
                expected_version: None
            },
            Some(&voided),
            &[]
        ),
        Decision::Unchanged { entry_id: id }
    );
    assert_eq!(
        decide(s, person, &update(None), Some(&voided), &[]),
        Decision::Error {
            code: "entry_voided"
        }
    );
    let edu = Section::Education;
    assert_eq!(
        decide(
            edu,
            person,
            &RowIntent::Create(mil(MilStatus::Exempt)),
            None,
            &[]
        ),
        Decision::Create
    );
}
