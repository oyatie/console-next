//! r3:hire-19: a conflict pattern is one decision — 「부서를 따름」 /
//! 「근무지를 따름 (미배치로)」 for a 부서 at another 사업장 than the 근무지,
//! 「입사 예정으로」 for 재직 with a future 입사일 — never row by row.

use std::collections::BTreeMap;

use uuid::Uuid;

use super::{World, row};
use crate::import::plan::{Decisions, ImportRow};

fn answered(key: &str, answer: &str) -> Decisions {
    Decisions {
        group_answers: BTreeMap::from([(key.to_owned(), answer.to_owned())]),
        ..Decisions::default()
    }
}

/// regression (r3:hire-19): the only way through a 부서/근무지 mismatch was to
/// exclude every such row.
#[test]
fn regression_a_unit_workplace_mismatch_is_answered_once_for_every_row() {
    let mut world = World::new(vec![]);
    let (unit, plant, hq) = (world.units["인사팀"][0], Uuid::new_v4(), Uuid::new_v4());
    world.unit_workplaces.insert(unit, plant);
    world.workplaces.insert("본사".into(), vec![hq]);
    let rows: Vec<ImportRow> = (0..3)
        .map(|n| ImportRow {
            workplace: Some("본사".into()),
            ..row(&format!("k{n}"), Some(&format!("E-{n}")), &format!("김{n}"))
        })
        .collect();
    let refused = world.plan(&rows, &Decisions::default());
    assert!(
        refused
            .iter()
            .all(|r| r.refusal_code == Some("workplace_conflict"))
    );

    let by_unit = world.plan(&rows, &answered("workplace_conflict", "follow_unit"));
    for r in &by_unit {
        let p = r.new_person.as_ref().unwrap();
        assert_eq!(
            (r.outcome, p.workplace_id, p.org_unit_id),
            ("insert", Some(plant), Some(unit))
        );
    }
    let by_place = world.plan(&rows, &answered("workplace_conflict", "follow_workplace"));
    for r in &by_place {
        let p = r.new_person.as_ref().unwrap();
        assert_eq!(
            (r.outcome, p.workplace_id, p.org_unit_id, p.unplaced_reason),
            ("insert", Some(hq), None, Some("unit_left_unplaced"))
        );
        assert_eq!(
            p.unresolved_org_unit.as_deref(),
            Some("인사팀"),
            "kept for the 미배치 queue"
        );
        assert_eq!(r.unit_name, None, "never asked again as a value");
    }
}

#[test]
fn active_with_a_future_hire_date_comes_in_pre_hire_when_answered() {
    let world = World::new(vec![]);
    let file = ImportRow {
        status: Some("ACTIVE".into()),
        hire_date: Some("2026-12-01".into()),
        ..row("k", Some("E-1"), "김일")
    };
    let refused = world.plan(std::slice::from_ref(&file), &Decisions::default());
    assert_eq!(refused[0].refusal_code, Some("status_conflict"));
    let pre = world.plan(&[file], &answered("status_conflict", "pre_hire"));
    assert_eq!(pre[0].new_person.as_ref().unwrap().status, "PRE_HIRE");
}
