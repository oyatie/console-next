use std::collections::BTreeMap;

use time::macros::date;
use uuid::Uuid;

use super::plan_rows;
use crate::import::plan::{Decisions, Exclusion, IdentityPick, ImportRow, OnFile, PlanFacts};

pub(super) fn row(key: &str, number: Option<&str>, name: &str) -> ImportRow {
    ImportRow {
        source_key: key.into(),
        sheet: "명부".into(),
        row: 2,
        name: name.into(),
        company: "".into(),
        employee_number: number.map(Into::into),
        hire_date: Some("2024-03-04".into()),
        org_unit: Some("인사팀".into()),
        position: Some("사원".into()),
        ..ImportRow::default()
    }
}

pub(super) fn person(number: &str, name: &str, status: &str) -> OnFile {
    OnFile {
        id: Uuid::new_v4(),
        employee_number: Some(number.into()),
        name: name.into(),
        status: status.into(),
        company: "Co".into(),
        period_starts: vec![date!(2024 - 03 - 04)],
        org_unit: Some("인사팀".into()),
        position: Some("사원".into()),
        observed: "2026-10-01T00:00:00Z".into(),
        ..OnFile::default()
    }
}

pub(super) struct World {
    pub company_workplaces: BTreeMap<String, Vec<Uuid>>,
    pub people: Vec<OnFile>,
    pub units: BTreeMap<String, Vec<Uuid>>,
    pub unit_workplaces: BTreeMap<Uuid, Uuid>,
    pub workplaces: BTreeMap<String, Vec<Uuid>>,
    pub former_load_open: bool,
    pub numbering: crate::import::numbering::Numbering,
}

impl World {
    pub fn new(people: Vec<OnFile>) -> Self {
        Self {
            company_workplaces: BTreeMap::new(),
            people,
            units: BTreeMap::from([("인사팀".into(), vec![Uuid::new_v4()])]),
            unit_workplaces: BTreeMap::new(),
            workplaces: BTreeMap::new(),
            former_load_open: true,
            numbering: crate::import::numbering::Numbering::default(),
        }
    }

    pub fn plan(&self, rows: &[ImportRow], decisions: &Decisions) -> Vec<super::PlannedRow> {
        let facts = PlanFacts {
            company_workplaces: &self.company_workplaces,
            people: &self.people,
            units: &self.units,
            unit_workplaces: &self.unit_workplaces,
            workplaces: &self.workplaces,
            today: date!(2026 - 10 - 05),
            former_load_open: self.former_load_open,
            numbering: &self.numbering,
        };
        plan_rows(rows, &facts, decisions)
    }
}

#[test]
fn a_known_number_is_that_person_whatever_its_place_in_the_file() {
    let world = World::new(vec![
        person("E-1", "김일", "ACTIVE"),
        person("E-2", "이이", "ACTIVE"),
    ]);
    // The same file re-uploaded with a row inserted above: positions moved.
    let rows = [
        row("f|r2", Some("E-9"), "박새"),
        row("f|r3", Some("E-1"), "김일"),
        row("f|r4", Some("E-2"), "이이"),
    ];
    let plan = world.plan(&rows, &Decisions::default());
    assert_eq!(plan[0].outcome, "insert");
    assert_eq!(plan[1].employee_id, Some(world.people[0].id));
    assert_eq!(plan[2].employee_id, Some(world.people[1].id));
    assert!(plan[1..].iter().all(|r| r.outcome == "unchanged"));
}

#[test]
fn import_never_moves_status_unit_or_exit_it_defers_them() {
    let mut on_leave = person("E-1", "김일", "ON_LEAVE");
    on_leave.job = Some("회계".into());
    let world = World::new(vec![on_leave]);
    let mut changed = row("f|r2", Some("E-1"), "김일");
    changed.job = Some("인사".into());
    changed.org_unit = Some("총무팀".into());
    changed.exit_date = Some("2026-09-30".into());
    let plan = &world.plan(&[changed], &Decisions::default())[0];
    assert_eq!(plan.outcome, "update");
    assert_eq!(plan.diff.len(), 1);
    assert_eq!(
        (plan.diff[0].field, plan.diff[0].to.as_str()),
        ("job", "인사")
    );
    let routes: Vec<_> = plan.deferred.iter().map(|d| (d.field, d.route)).collect();
    assert_eq!(
        routes,
        [
            ("org_unit", "lifecycle_transfer"),
            ("exit_date", "exit_case")
        ]
    );
}

#[test]
fn a_contradiction_is_identity_mismatch_not_a_rename() {
    let mut known = person("E-1", "김일", "ACTIVE");
    known.birth_date = Some(date!(1990 - 01 - 01));
    let world = World::new(vec![known]);
    let renamed = row("a", Some("E-1"), "김다른");
    let mut reborn = row("b", Some("E-1"), "김일");
    reborn.birth_date = Some("1991-01-01".into());
    let mut rehired = row("c", Some("E-1"), "김일");
    rehired.hire_date = Some("2025-01-01".into());
    let plan = world.plan(&[renamed], &Decisions::default());
    assert_eq!(
        (plan[0].refusal_code, plan[0].refusal_field),
        (Some("identity_mismatch"), Some("name"))
    );
    let plan = world.plan(&[reborn], &Decisions::default());
    assert_eq!(plan[0].refusal_field, Some("birth_date"));
    let plan = world.plan(&[rehired], &Decisions::default());
    assert_eq!(plan[0].refusal_field, Some("hire_date"));
}

#[test]
fn a_number_twice_in_the_file_is_refused_on_both_rows() {
    let world = World::new(vec![]);
    let plan = world.plan(
        &[row("a", Some("E-7"), "김일"), row("b", Some("E-7"), "김이")],
        &Decisions::default(),
    );
    assert!(
        plan.iter()
            .all(|r| r.refusal_code == Some("duplicate_in_file"))
    );
}

#[test]
fn a_row_without_a_number_waits_for_the_operator_when_a_namesake_exists() {
    let world = World::new(vec![person("E-1", "김일", "EXITED")]);
    let bare = row("a", None, "김 일");
    let plan = world.plan(std::slice::from_ref(&bare), &Decisions::default());
    assert_eq!(plan[0].outcome, "unresolved_identity");
    assert_eq!(plan[0].candidates[0].basis, "name_only");
    let mut decisions = Decisions::default();
    decisions
        .identity
        .insert("a".into(), IdentityPick { employee_id: None });
    assert_eq!(
        world.plan(std::slice::from_ref(&bare), &decisions)[0].outcome,
        "insert"
    );
    decisions.identity.insert(
        "a".into(),
        IdentityPick {
            employee_id: Some(world.people[0].id),
        },
    );
    let picked = &world.plan(&[bare], &decisions)[0];
    assert_eq!(picked.employee_id, Some(world.people[0].id));
    assert_eq!(picked.deferred[0].route, "rehire");
}

#[test]
fn a_new_person_needs_a_date_and_one_unit() {
    let world = World::new(vec![]);
    let mut undated = row("a", Some("E-1"), "김일");
    undated.hire_date = None;
    let mut garbled = row("b", Some("E-2"), "김이");
    garbled.hire_date = Some("내년 봄".into());
    let mut elsewhere = row("c", Some("E-3"), "김삼");
    elsewhere.org_unit = Some("없는팀".into());
    let plan = world.plan(
        &[undated, garbled, elsewhere.clone()],
        &Decisions::default(),
    );
    assert_eq!(plan[0].refusal_code, Some("hire_date_required"));
    assert_eq!(
        (plan[1].refusal_code, plan[1].refusal_field),
        (Some("invalid_date"), Some("hire_date"))
    );
    // An unknown unit is no question that blocks apply: 미배치, name kept.
    let unplaced = plan[2].new_person.as_ref().unwrap();
    assert_eq!(
        (plan[2].outcome, plan[2].unit_name.as_deref()),
        ("insert", Some("없는팀"))
    );
    assert_eq!(
        (unplaced.org_unit_id, unplaced.org_unit.as_deref()),
        (None, None)
    );
    assert_eq!(unplaced.unresolved_org_unit.as_deref(), Some("없는팀"));
    let unit = Uuid::new_v4();
    let decisions = Decisions {
        unit_map: BTreeMap::from([("없는팀".into(), Some(unit))]),
        ..Decisions::default()
    };
    let mapped = &world.plan(&[elsewhere], &decisions)[0];
    assert_eq!(mapped.new_person.as_ref().unwrap().org_unit_id, Some(unit));
}

#[test]
fn future_and_former_people_get_their_status() {
    let mut world = World::new(vec![]);
    let mut future = row("a", Some("E-1"), "김일");
    future.hire_date = Some("2026-11-01".into());
    let mut former = row("b", Some("E-2"), "김이");
    former.exit_date = Some("2025-12-31".into());
    let plan = world.plan(&[future, former.clone()], &Decisions::default());
    assert_eq!(plan[0].new_person.as_ref().unwrap().status, "PRE_HIRE");
    let loaded = plan[1].new_person.as_ref().unwrap();
    assert_eq!((loaded.status, loaded.migrated_former), ("EXITED", true));
    world.former_load_open = false;
    let plan = world.plan(&[former], &Decisions::default());
    assert_eq!(plan[0].refusal_code, Some("former_load_closed"));
}

#[test]
fn an_excluded_row_is_only_excluded() {
    let world = World::new(vec![]);
    let decisions = Decisions {
        exclusions: BTreeMap::from([(
            "a".into(),
            Exclusion {
                reason_code: "OUT_OF_SCOPE".into(),
                note: None,
            },
        )]),
        ..Decisions::default()
    };
    let mut broken = row("a", Some("E-1"), "김일");
    broken.hire_date = Some("??".into());
    let plan = &world.plan(&[broken], &decisions)[0];
    assert_eq!(
        (plan.outcome, plan.exclusion_code.as_deref()),
        ("excluded", Some("OUT_OF_SCOPE"))
    );
    assert!(plan.is_settled());
}

#[path = "plan_place_tests.rs"]
mod place;

#[path = "plan_import2_tests.rs"]
mod import2;

#[path = "summary_tests.rs"]
mod summary;

#[path = "plan_group_tests.rs"]
mod group;

#[path = "plan_entity_tests.rs"]
mod entity;

#[path = "plan_answers_tests.rs"]
mod answers;
