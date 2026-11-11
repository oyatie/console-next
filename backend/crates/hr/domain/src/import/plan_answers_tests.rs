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

/// regression: a roster whose dates carry two-digit years (`24.03.04`) had
/// every row refused `invalid_date`, with leaving the rows out as the only way on.
#[test]
fn regression_two_digit_years_wait_for_one_answer_then_read() {
    let world = World::new(vec![]);
    let rows: Vec<ImportRow> = [("24.03.04", "98.07.01"), ("19년 11월 1일", "01.02.03")]
        .iter()
        .enumerate()
        .map(|(n, (hire, birth))| ImportRow {
            hire_date: Some((*hire).into()),
            birth_date: Some((*birth).into()),
            contract_end_date: Some("27.03.03".into()),
            ..row(&format!("k{n}"), Some(&format!("E-{n}")), &format!("김{n}"))
        })
        .collect();
    let waiting = world.plan(&rows, &Decisions::default());
    for r in &waiting {
        assert_eq!(
            (r.outcome, r.refusal_code, r.refusal_field),
            ("refused", Some("two_digit_year"), Some("hire_date"))
        );
    }

    let read = world.plan(&rows, &answered("two_digit_year", "recent"));
    let dates: Vec<_> = read
        .iter()
        .map(|r| {
            let p = r.new_person.as_ref().unwrap();
            (r.outcome, p.hire_date.as_str(), p.birth_date.as_deref())
        })
        .collect();
    assert_eq!(
        dates,
        [
            ("insert", "2024-03-04", Some("1998-07-01")),
            ("insert", "2019-11-01", Some("2001-02-03")),
        ]
    );
}

/// The answer never places a year that is plausible in neither century, and
/// never touches a cell that is not a date.
#[test]
fn an_answered_run_still_refuses_what_has_no_plausible_year() {
    let world = World::new(vec![]);
    let with = |hire: &str, birth: Option<&str>, end: Option<&str>| ImportRow {
        hire_date: Some(hire.into()),
        birth_date: birth.map(Into::into),
        contract_end_date: end.map(Into::into),
        ..row("k", Some("E-1"), "김일")
    };
    let refusal = |row: ImportRow| {
        let planned = world.plan(&[row], &answered("two_digit_year", "recent"));
        (planned[0].refusal_code, planned[0].refusal_field)
    };
    // today is 2026-10-05: 2030 is too far ahead, 1930 too long ago.
    assert_eq!(
        refusal(with("30.01.01", None, None)),
        (Some("invalid_date"), Some("hire_date"))
    );
    assert_eq!(
        refusal(with("24.03.04", Some("20.01.01"), None)),
        (Some("invalid_date"), Some("birth_date"))
    );
    // An end before the hire has no year after it within reach.
    assert_eq!(
        refusal(with("2024-03-04", None, Some("23.12.31"))),
        (Some("invalid_date"), Some("contract_end_date"))
    );
    assert_eq!(
        refusal(with("입사", None, None)),
        (Some("invalid_date"), Some("hire_date"))
    );
    // Without the answer an end date waits like any other.
    let unasked = world.plan(
        &[with("2024-03-04", None, Some("27.03.03"))],
        &Decisions::default(),
    );
    assert_eq!(
        (unasked[0].refusal_code, unasked[0].refusal_field),
        (Some("two_digit_year"), Some("contract_end_date"))
    );
}

/// A leave's dates follow the hire, so their two-digit years read after it.
#[test]
fn a_leave_written_with_two_digit_years_reads_after_the_hire() {
    let world = World::new(vec![]);
    let leave = ImportRow {
        status: Some("휴직".into()),
        leave_type: Some("육아휴직".into()),
        leave_start_date: Some("26.03.02".into()),
        leave_return_date: Some("27.03.01".into()),
        ..row("k", Some("E-1"), "김일")
    };
    let waiting = world.plan(std::slice::from_ref(&leave), &Decisions::default());
    assert_eq!(
        (waiting[0].refusal_code, waiting[0].refusal_field),
        (Some("two_digit_year"), Some("leave_start_date"))
    );
    let read = world.plan(&[leave], &answered("two_digit_year", "recent"));
    let setup = read[0].new_person.as_ref().unwrap().leave.as_ref().unwrap();
    assert_eq!(
        (
            setup.start_date.as_str(),
            setup.expected_return_date.as_deref()
        ),
        ("2026-03-02", Some("2027-03-01"))
    );
}
