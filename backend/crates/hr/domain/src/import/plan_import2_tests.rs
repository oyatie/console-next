//! IMPORT-2: matching order, 동명이인, setup status facts and 사번 numbering.

use std::collections::{BTreeMap, BTreeSet};

use time::macros::date;
use uuid::Uuid;

use super::{World, person, row};
use crate::import::numbering::{NumberRule, Numbering};
use crate::import::plan::{Decisions, IdentityPick};

fn hashed(n: u8) -> Option<Vec<u8>> {
    Some(vec![n; 32])
}

#[test]
fn an_alias_finds_the_person_but_an_rrn_alone_requires_review() {
    let mut renumbered = person("S-1", "김일", "ACTIVE");
    renumbered.aliases = vec!["E-1".into()];
    let mut sealed = person("E-2", "이이", "ACTIVE");
    sealed.rrn_hmac = hashed(2);
    let world = World::new(vec![renumbered, sealed]);
    let by_alias = row("a", Some("E-1"), "김일");
    let mut by_rrn = row("b", None, "이이");
    by_rrn.rrn_hmac = hashed(2);
    let mut new_number = row("c", Some("X-9"), "이이");
    new_number.rrn_hmac = hashed(2);
    let plan = world.plan(&[by_alias, by_rrn], &Decisions::default());
    assert_eq!(
        (plan[0].matched_by, plan[0].employee_id),
        (Some("alias"), Some(world.people[0].id))
    );
    assert_eq!(plan[1].outcome, "unresolved_identity");
    assert_eq!(plan[1].employee_id, None);
    assert_eq!(plan[1].candidates[0].employee_id, world.people[1].id);
    let plan = &world.plan(&[new_number], &Decisions::default())[0];
    assert_eq!(plan.outcome, "unresolved_identity");
    assert_eq!(plan.employee_id, None);
}

#[test]
fn a_number_and_an_rrn_naming_two_people_is_a_conflict_not_a_merge() {
    let mut other = person("E-2", "김일", "ACTIVE");
    other.rrn_hmac = hashed(9);
    let mut first = person("E-1", "김일", "ACTIVE");
    first.rrn_hmac = hashed(1);
    let world = World::new(vec![first, other]);
    let mut both = row("a", Some("E-1"), "김일");
    both.rrn_hmac = hashed(9);
    let plan = &world.plan(&[both], &Decisions::default())[0];
    assert_eq!(
        (plan.refusal_code, plan.refusal_field),
        (Some("identity_conflict"), Some("rrn"))
    );
    assert_eq!(plan.candidates[0].employee_id, world.people[1].id);
    let mut mismatch = person("E-3", "박삼", "ACTIVE");
    mismatch.rrn_hmac = hashed(3);
    let world = World::new(vec![mismatch]);
    let mut differs = row("b", Some("E-3"), "박삼");
    differs.rrn_hmac = hashed(4);
    let plan = &world.plan(&[differs], &Decisions::default())[0];
    assert_eq!(
        (plan.refusal_code, plan.refusal_field),
        (Some("identity_mismatch"), Some("rrn"))
    );
}

#[test]
fn namesakes_are_told_apart_by_identity_details_never_by_a_suffix() {
    let mut a = person("E-1", "홍길동", "ACTIVE");
    a.birth_date = Some(date!(1990 - 01 - 15));
    let mut b = person("E-2", "홍길동", "ACTIVE");
    b.org_unit = Some("영업팀".into());
    let world = World::new(vec![a, b]);
    let plan = &world.plan(&[row("x", None, "홍길동")], &Decisions::default())[0];
    assert_eq!(plan.outcome, "unresolved_identity");
    assert_eq!(plan.name, "홍길동");
    let masked: Vec<_> = plan
        .candidates
        .iter()
        .map(|c| c.birth_date_masked.clone())
        .collect();
    assert_eq!(masked, [Some("1990-01-**".into()), None]);
    assert_eq!(plan.candidates[1].org_unit.as_deref(), Some("영업팀"));
    // Two records with one RRN (a 재입사) are candidates too.
    let mut c = person("E-3", "김삼", "EXITED");
    c.rrn_hmac = hashed(5);
    let mut d = person("E-4", "김삼", "ACTIVE");
    d.rrn_hmac = hashed(5);
    let world = World::new(vec![c, d]);
    let mut twice = row("y", None, "김삼");
    twice.rrn_hmac = hashed(5);
    let plan = &world.plan(&[twice], &Decisions::default())[0];
    assert_eq!(plan.outcome, "unresolved_identity");
    assert!(plan.candidates.iter().all(|c| c.basis == "rrn"));
    // Choosing "new" while the 사번 is someone's is refused.
    let decisions = Decisions {
        identity: BTreeMap::from([("z".into(), IdentityPick { employee_id: None })]),
        ..Decisions::default()
    };
    let plan = &world.plan(&[row("z", Some("E-3"), "김삼")], &decisions)[0];
    assert_eq!(plan.refusal_code, Some("identity_conflict"));
}

#[test]
fn a_stated_status_is_a_setup_fact_that_must_agree_with_the_dates() {
    let world = World::new(vec![]);
    let with = |key: &str, status: &str| {
        let mut r = row(key, Some(&format!("N-{key}")), "가나");
        r.status = Some(status.into());
        r
    };
    let mut leave = with("a", "휴직");
    leave.leave_start_date = Some("2026-03-02".into());
    leave.leave_type = Some("육아휴직".into());
    leave.leave_return_date = Some("2027-03-01".into());
    let mut no_start = with("b", "휴직");
    no_start.leave_type = Some("병가".into());
    let mut no_type = with("c", "휴직");
    no_type.leave_start_date = Some("2026-03-02".into());
    let gone = with("d", "퇴사");
    let mut active_but_left = with("e", "재직");
    active_but_left.exit_date = Some("2025-01-01".into());
    let odd = with("f", "파견");
    let plan = world.plan(
        &[leave, no_start, no_type, gone, active_but_left, odd.clone()],
        &Decisions::default(),
    );
    let new = plan[0].new_person.as_ref().unwrap();
    assert_eq!(new.status, "ON_LEAVE");
    let setup = new.leave.as_ref().unwrap();
    assert_eq!(
        (setup.start_date.as_str(), setup.leave_type),
        ("2026-03-02", "CHILDCARE")
    );
    assert_eq!(setup.expected_return_date.as_deref(), Some("2027-03-01"));
    let codes: Vec<_> = plan[1..].iter().map(|p| p.refusal_code.unwrap()).collect();
    assert_eq!(
        codes,
        [
            "leave_start_required",
            "leave_type_unmapped",
            "exit_date_required",
            "status_conflict",
            "status_unmapped"
        ]
    );
    let decisions = Decisions {
        status_map: BTreeMap::from([("파견".into(), "ACTIVE".into())]),
        ..Decisions::default()
    };
    assert_eq!(
        world.plan(&[odd], &decisions)[0]
            .new_person
            .as_ref()
            .unwrap()
            .status,
        "ACTIVE"
    );
}

#[test]
fn a_new_person_without_a_number_gets_the_rules_next_one_or_none() {
    let mut world = World::new(vec![]);
    let rows = [
        row("a", None, "가"),
        row("b", None, "나"),
        row("c", Some("E-000005"), "다"),
    ];
    let unnumbered = world.plan(&rows, &Decisions::default());
    assert_eq!(
        unnumbered[0].new_person.as_ref().unwrap().employee_number,
        None
    );
    world.numbering = Numbering {
        assign: true,
        taken: BTreeSet::from(["E-000004".into()]),
        ..Numbering::default()
    };
    let plan = world.plan(&rows, &Decisions::default());
    let numbers: Vec<_> = plan
        .iter()
        .map(|p| p.employee_number.clone().unwrap())
        .collect();
    assert_eq!(numbers, ["E-000006", "E-000007", "E-000005"]);
    assert_eq!(
        plan[0].new_person.as_ref().unwrap().employee_number_source,
        Some("rule")
    );
    let workplace = Uuid::new_v4();
    world.numbering.by_workplace.insert(
        workplace,
        NumberRule {
            prefix: "P".into(),
            width: 3,
        },
    );
    assert_eq!(world.numbering.rule_for(Some(workplace)).format(1), "P001");
    // The operator's own number, refused when someone holds it.
    let decisions = Decisions {
        employee_numbers: BTreeMap::from([
            ("a".into(), "M-1".into()),
            ("b".into(), "E-000004".into()),
        ]),
        ..Decisions::default()
    };
    let plan = world.plan(&rows[..2], &decisions);
    assert_eq!(
        plan[0].new_person.as_ref().unwrap().employee_number_source,
        Some("manual")
    );
    assert_eq!(plan[1].refusal_code, Some("employee_number_taken"));
    // A file number a voided record still holds is refused, not inserted.
    let plan = world.plan(&[row("d", Some("E-000004"), "라")], &Decisions::default());
    assert_eq!(plan[0].refusal_code, Some("employee_number_taken"));
}
