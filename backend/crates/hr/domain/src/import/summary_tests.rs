//! W02 / W03: the counts the apply button names.

use std::collections::BTreeMap;

use uuid::Uuid;

use super::{World, row};
use crate::import::plan::Decisions;
use crate::import::summary::{
    auto_mapped, employment_type_empty_rows, phone_unstored_rows, unplaced,
};

/// regression (W02 / W03): the walkthrough's file — 정규직 rows applied
/// with no 고용형태, near-miss 부서 applied 미배치 — with nothing counted.
#[test]
fn regression_labels_and_unplaced_people_are_counted() {
    let mut world = World::new(vec![]);
    let hr = world.units["인사팀"][0];
    world.unit_workplaces.insert(hr, Uuid::new_v4());
    world
        .units
        .insert("총무팀".into(), vec![Uuid::new_v4(), Uuid::new_v4()]);
    let mut rows = Vec::new();
    for (i, (kind, unit)) in [
        (Some("정규직"), Some("인사팀")),
        (Some("정규직"), Some("영업 2팀")),
        (Some("계약"), Some("총무팀")),
        (Some("REGULAR"), Some("생산1팀")),
        (Some("촉탁"), None),
        (None, Some("인사팀")),
    ]
    .into_iter()
    .enumerate()
    {
        let mut r = row(&format!("k{i}"), Some(&format!("E-{i}")), "김일");
        r.employment_type = kind.map(Into::into);
        r.org_unit = unit.map(Into::into);
        rows.push(r);
    }
    let decisions = Decisions {
        unit_map: BTreeMap::from([("생산1팀".into(), None)]),
        employment_type_map: BTreeMap::from([("촉탁".into(), None)]),
        ..Decisions::default()
    };
    let plan = world.plan(&rows, &decisions);
    assert!(plan.iter().all(|p| p.outcome == "insert"), "{plan:?}");
    let mapped: Vec<_> = auto_mapped(&rows, &plan, &decisions)
        .into_iter()
        .map(|a| (a.value, a.code, a.rows))
        .collect();
    assert_eq!(
        mapped,
        [
            ("계약".into(), "CONTRACT", 1),
            ("정규직".into(), "REGULAR", 2)
        ]
    );
    // 촉탁 answered `null` and the row with no cell.
    assert_eq!(employment_type_empty_rows(&plan), 2);
    let u = unplaced(&plan);
    assert_eq!(u.rows, 4);
    assert_eq!(
        u.by_reason,
        BTreeMap::from([
            ("no_place".to_owned(), 1),
            ("unit_ambiguous".to_owned(), 1),
            ("unit_left_unplaced".to_owned(), 1),
            ("unit_unknown".to_owned(), 1),
        ])
    );
}

#[test]
fn an_operator_answer_is_not_an_auto_mapping_and_refused_rows_count_nothing() {
    let world = World::new(vec![]);
    let mut answered = row("a", Some("E-1"), "김일");
    answered.employment_type = Some("정규직".into());
    let mut refused = row("b", Some("E-2"), "김이");
    refused.employment_type = Some("정규직".into());
    refused.hire_date = Some("someday".into());
    let decisions = Decisions {
        employment_type_map: BTreeMap::from([("정규직".into(), Some("CONTRACT".into()))]),
        ..Decisions::default()
    };
    let rows = [answered, refused];
    let plan = world.plan(&rows, &decisions);
    assert_eq!(plan[1].outcome, "refused");
    assert!(auto_mapped(&rows, &plan, &decisions).is_empty());
    assert_eq!(
        plan[0]
            .new_person
            .as_ref()
            .unwrap()
            .employment_type
            .as_deref(),
        Some("CONTRACT"),
        "the operator's answer wins over the catalog"
    );
    assert_eq!(unplaced(&plan).rows, 1, "인사팀 sits under no 사업장 here");
    assert_eq!(unplaced(&plan).by_reason["workplace_unknown"], 1);
}

#[test]
fn regression_a_phone_not_stored_is_counted_never_silent() {
    let world = World::new(vec![]);
    let mut typed = row("a", Some("E-1"), "김일");
    typed.employment_type = Some("정규직".into());
    typed.has_phone = true;
    let mut untyped = row("b", Some("E-2"), "김이");
    untyped.has_phone = true;
    let none = row("c", Some("E-3"), "김삼");
    let rows = [typed, untyped, none];
    let plan = world.plan(&rows, &Decisions::default());
    assert_eq!(phone_unstored_rows(&rows, &plan), 1);

    // A person on file keeps their phone (인사카드): counted, never silent.
    let world = World::new(vec![super::person("E-9", "김구", "ACTIVE")]);
    let mut on_file = row("d", Some("E-9"), "김구");
    on_file.has_phone = true;
    let rows = [on_file];
    let plan = world.plan(&rows, &Decisions::default());
    assert_eq!(plan[0].outcome, "unchanged");
    assert_eq!(phone_unstored_rows(&rows, &plan), 1);
}

#[test]
fn a_missing_department_does_not_count_a_workplace_placement_as_unplaced() {
    let world = World::new(vec![]);
    let mut plans = world.plan(
        &[row("placed", Some("PLACE-1"), "배치직원")],
        &Decisions::default(),
    );
    // N-1 plans retain the department-review reason beside the actual workplace.
    let person = plans[0].new_person.as_mut().unwrap();
    person.org_unit_id = None;
    person.workplace_id = Some(Uuid::new_v4());
    person.unplaced_reason = Some("unit_left_unplaced");
    assert_eq!(unplaced(&plans).rows, 0);
    assert!(unplaced(&plans).by_reason.is_empty());
}
