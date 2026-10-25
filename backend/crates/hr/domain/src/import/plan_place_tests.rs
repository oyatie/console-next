//! MR-7: placement, 미배치 and the 고용형태 of imported rows.

use std::collections::BTreeMap;

use uuid::Uuid;

use super::{World, person, row};
use crate::import::plan::Decisions;

#[test]
fn a_reviewed_employer_never_hides_an_unresolved_department() {
    let mut world = World::new(vec![]);
    let home = Uuid::new_v4();
    let mut input = row("company", Some("E-1"), "김직원");
    input.company = "GANATECH".into();
    input.org_unit = None;
    let key = crate::import::company_review::company_key(&input);
    world.company_workplaces.insert(key.clone(), vec![home]);
    let mut decisions = Decisions::default();
    decisions.company_map.insert(key, Some(home));
    assert_eq!(
        world.plan(&[input.clone()], &decisions)[0]
            .new_person
            .as_ref()
            .unwrap()
            .workplace_id,
        Some(home)
    );
    input.org_unit = Some("찾지 못한 부서".into());
    let planned = world.plan(&[input], &decisions);
    let person = planned[0].new_person.as_ref().unwrap();
    assert_eq!((person.org_unit_id, person.workplace_id), (None, None));
    assert_eq!(person.unplaced_reason, Some("unit_unknown"));
}

#[test]
fn company_evidence_contains_placement_and_unknown_aliases_stay_unplaced() {
    let mut world = World::new(vec![]);
    let home = Uuid::new_v4();
    let other = Uuid::new_v4();
    let unit = world.units["인사팀"][0];
    world.unit_workplaces.insert(unit, other);
    world.workplaces.insert("본사".into(), vec![home]);
    world.workplaces.insert("다른법인".into(), vec![other]);
    let mut input = row("alias", Some("E-1"), "김직원");
    for (label, brn) in [("GANATECH", None), ("", Some("0000000000"))] {
        input.company = label.into();
        input.company_brn = brn.map(str::to_owned);
        let person = world.plan(std::slice::from_ref(&input), &Decisions::default())[0]
            .new_person
            .clone()
            .unwrap();
        assert_eq!((person.org_unit_id, person.workplace_id), (None, None));
        assert_eq!(person.unplaced_reason, Some("unit_unknown"));
    }
    input.company = "GANATECH".into();
    input.company_brn = None;
    let key = crate::import::company_review::company_key(&input);
    let mut decisions = Decisions::default();
    decisions.company_map.insert(key.clone(), Some(home));
    world.company_workplaces.insert(key, vec![home]);
    for answer in [None, Some("follow_unit"), Some("follow_workplace")] {
        if let Some(answer) = answer {
            decisions
                .group_answers
                .insert("workplace_conflict".into(), answer.into());
        }
        let plan = world.plan(std::slice::from_ref(&input), &decisions);
        assert_eq!(plan[0].refusal_code, Some("workplace_conflict"));
    }
    input.org_unit = None;
    input.workplace = Some("다른법인".into());
    assert_eq!(
        world.plan(std::slice::from_ref(&input), &decisions)[0].refusal_code,
        Some("workplace_conflict")
    );
    decisions
        .workplace_map
        .insert("다른법인".into(), Some(other));
    assert_eq!(
        world.plan(std::slice::from_ref(&input), &decisions)[0].refusal_code,
        Some("workplace_conflict")
    );
    input.workplace = Some("본사".into());
    let person = world.plan(std::slice::from_ref(&input), &decisions)[0]
        .new_person
        .clone()
        .unwrap();
    assert_eq!(person.workplace_id, Some(home));
    input.org_unit = Some("인사팀".into());
    // The selected workplace wins this conflict; the rejected unit must not follow it.
    let person = world.plan(std::slice::from_ref(&input), &decisions)[0]
        .new_person
        .clone()
        .unwrap();
    assert_eq!(
        (person.org_unit_id, person.workplace_id),
        (None, Some(home))
    );
    world.unit_workplaces.insert(unit, home);
    let person = world.plan(&[input], &decisions)[0]
        .new_person
        .clone()
        .unwrap();
    assert_eq!(
        (person.org_unit_id, person.workplace_id),
        (Some(unit), Some(home))
    );
}

#[test]
fn a_new_person_is_placed_at_the_workplace_of_their_unit_or_their_workplace_text() {
    let mut world = World::new(vec![]);
    let (unit, at_unit, named) = (world.units["인사팀"][0], Uuid::new_v4(), Uuid::new_v4());
    world.unit_workplaces.insert(unit, at_unit);
    world.workplaces.insert("본사".into(), vec![at_unit]);
    world.workplaces.insert("공장".into(), vec![named]);
    world
        .workplaces
        .insert("지점".into(), vec![Uuid::new_v4(), Uuid::new_v4()]);

    let by_unit = row("a", Some("E-1"), "김일");
    let mut by_text = row("b", Some("E-2"), "김이");
    by_text.org_unit = None;
    by_text.workplace = Some("공장".into());
    let mut both = row("c", Some("E-3"), "김삼");
    both.workplace = Some("공장".into());
    let mut site = row("d", Some("E-4"), "김사");
    site.org_unit = None;
    site.workplace = Some("강남현장".into());
    let mut twice = row("e", Some("E-5"), "김오");
    twice.org_unit = None;
    twice.workplace = Some("지점".into());
    let plan = world.plan(
        &[by_unit, by_text, both, site, twice],
        &Decisions::default(),
    );
    let placed = |i: usize| plan[i].new_person.as_ref().unwrap().workplace_id;
    assert_eq!((placed(0), placed(1)), (Some(at_unit), Some(named)));
    // The unit and the 사업장 text disagree: a question, not a guess.
    assert_eq!(
        (plan[2].refusal_code, plan[2].refusal_field),
        (Some("workplace_conflict"), Some("workplace"))
    );
    // A 현장 name or an ambiguous name places nobody, and says so.
    assert_eq!(
        (placed(3), plan[3].workplace_name.as_deref()),
        (None, Some("강남현장"))
    );
    assert_eq!(
        (placed(4), plan[4].workplace_name.as_deref()),
        (None, Some("지점"))
    );

    // The operator answers: 공장 text is not a 사업장 here; 지점 is that one.
    let decisions = Decisions {
        workplace_map: BTreeMap::from([("공장".into(), None), ("지점".into(), Some(named))]),
        ..Decisions::default()
    };
    let mut both = row("c", Some("E-3"), "김삼");
    both.workplace = Some("공장".into());
    let mut twice = row("e", Some("E-5"), "김오");
    twice.org_unit = None;
    twice.workplace = Some("지점".into());
    let plan = world.plan(&[both, twice], &decisions);
    let placed = |i: usize| plan[i].new_person.as_ref().unwrap().workplace_id;
    assert_eq!((placed(0), placed(1)), (Some(at_unit), Some(named)));
    assert_eq!(plan[0].workplace_name, None);
}

#[test]
fn an_unmapped_unit_or_type_never_blocks_and_a_former_employee_is_not_placed() {
    let mut world = World::new(vec![]);
    world
        .unit_workplaces
        .insert(world.units["인사팀"][0], Uuid::new_v4());
    let mut unknown = row("a", Some("E-1"), "김일");
    unknown.org_unit = Some("생산 1팀".into());
    unknown.employment_type = Some("촉탁".into());
    let mut coded = row("b", Some("E-2"), "김이");
    coded.employment_type = Some("contract".into());
    let mut former = row("c", Some("E-3"), "김삼");
    former.exit_date = Some("2025-12-31".into());
    let plan = world.plan(&[unknown, coded, former], &Decisions::default());
    let unplaced = plan[0].new_person.as_ref().unwrap();
    assert_eq!(plan[0].outcome, "insert");
    assert_eq!(
        (
            unplaced.org_unit_id,
            unplaced.workplace_id,
            unplaced.employment_type.as_deref()
        ),
        (None, None, None)
    );
    assert_eq!(
        (plan[0].deferred[0].field, plan[0].deferred[0].route),
        ("employment_type", "value_map")
    );
    let coded = plan[1].new_person.as_ref().unwrap();
    assert_eq!(coded.employment_type.as_deref(), Some("CONTRACT"));
    assert!(coded.workplace_id.is_some());
    // r3:hire-22: a former employee is found at their unit's 사업장, never bound.
    let former = plan[2].new_person.as_ref().unwrap();
    let hq = world.unit_workplaces[&world.units["인사팀"][0]];
    assert_eq!(
        (former.status, former.workplace_id, former.org_unit_id),
        ("EXITED", Some(hq), None)
    );

    let decisions = Decisions {
        employment_type_map: BTreeMap::from([("촉탁".into(), Some("CONTRACT".into()))]),
        unit_map: BTreeMap::from([("생산 1팀".into(), None)]),
        ..Decisions::default()
    };
    let mut unknown = row("a", Some("E-1"), "김일");
    unknown.org_unit = Some("생산 1팀".into());
    unknown.employment_type = Some("촉탁".into());
    let plan = world.plan(&[unknown], &decisions);
    let answered = plan[0].new_person.as_ref().unwrap();
    assert_eq!(answered.employment_type.as_deref(), Some("CONTRACT"));
    assert_eq!(answered.unresolved_org_unit.as_deref(), Some("생산 1팀"));
    assert!(plan[0].deferred.is_empty());
}

#[test]
fn an_existing_person_gets_a_missing_type_and_a_different_one_is_a_correction() {
    let mut typed = person("E-2", "김이", "ACTIVE");
    typed.employment_type = Some("REGULAR".into());
    let world = World::new(vec![person("E-1", "김일", "ACTIVE"), typed]);
    let mut fill = row("a", Some("E-1"), "김일");
    fill.employment_type = Some("REGULAR".into());
    let mut differ = row("b", Some("E-2"), "김이");
    differ.employment_type = Some("PART_TIME".into());
    let plan = world.plan(&[fill, differ], &Decisions::default());
    assert_eq!(plan[0].outcome, "update");
    assert_eq!(
        (plan[0].diff[0].field, plan[0].diff[0].to.as_str()),
        ("employment_type", "REGULAR")
    );
    assert_eq!(plan[1].outcome, "unchanged");
    assert_eq!(
        (plan[1].deferred[0].field, plan[1].deferred[0].route),
        ("employment_type", "correction")
    );
}

#[test]
fn physical_worksite_never_binds_a_statutory_workplace() {
    let mut world = World::new(vec![]);
    world.workplaces.insert("본사".into(), vec![Uuid::new_v4()]);
    let mut input = row("site-only", Some("PLACE-1"), "김근무");
    input.company.clear();
    input.org_unit = None;
    input.worksite_name = Some("본사".into());
    let plans = world.plan(&[input], &Decisions::default());
    let person = plans[0].new_person.as_ref().unwrap();
    assert_eq!(person.workplace_id, None);
    assert_eq!(person.unplaced_reason, Some("no_place"));
}
