//! r3:worst-case-22: a file that names another 법인 for a person on file is
//! a 전적 to settle (or a mistake), never 「발령으로 처리합니다」.

use super::{World, person, row};
use crate::import::plan::{Decisions, ENTITY_UNDECIDED, ImportRow};

fn routes(
    company: &str,
    on_file: &str,
    unit: &str,
    same: bool,
) -> Vec<(&'static str, &'static str)> {
    let mut p = person("E-2", "김민수", "ACTIVE");
    p.company = on_file.into();
    let current = uuid::Uuid::new_v4();
    p.workplace_id = (on_file != ENTITY_UNDECIDED).then_some(current);
    let mut world = World::new(vec![p]);
    let file = ImportRow {
        company: company.into(),
        org_unit: Some(unit.into()),
        ..row("k", Some("E-2"), "김민수")
    };
    let mut decisions = Decisions::default();
    if !company.is_empty() {
        let target = if same { current } else { uuid::Uuid::new_v4() };
        let key = crate::import::company_review::company_key(&file);
        decisions.company_map.insert(key.clone(), Some(target));
        world.company_workplaces.insert(key, vec![target]);
    }
    world.plan(&[file], &decisions)[0]
        .deferred
        .iter()
        .map(|d| (d.field, d.route))
        .collect()
}

/// regression (r3:worst-case-22): the 법인 change went unreported and the 부서
/// change was routed to 발령, which is refused across a 법인.
#[test]
fn regression_another_entity_is_an_entity_transfer_never_an_appointment() {
    assert_eq!(
        routes("주식회사 한결랩", "주식회사 한빛", "연구팀", false),
        vec![
            ("company", "entity_transfer"),
            ("org_unit", "entity_transfer")
        ]
    );
}

#[test]
fn the_same_entity_in_other_words_and_no_entity_column_move_nobody() {
    assert_eq!(
        routes("(주)한빛", "주식회사 한빛", "연구팀", true),
        vec![("org_unit", "lifecycle_transfer")]
    );
    assert_eq!(
        routes("", "주식회사 한빛", "인사팀", true),
        Vec::<(&str, &str)>::new()
    );
    assert_eq!(
        routes("주식회사 한결랩", ENTITY_UNDECIDED, "인사팀", false),
        Vec::<(&str, &str)>::new()
    );
}

#[test]
fn reviewed_english_alias_of_the_same_employer_never_becomes_a_transfer() {
    assert!(routes("GANATECH", "주식회사 가나테크", "인사팀", true).is_empty());
}

#[test]
fn the_existing_employment_type_is_never_overwritten_by_an_import() {
    for (stored, incoming, route, changes) in [
        (Some("REGULAR"), "REGULAR", None, 0),
        (Some("REGULAR"), "PART_TIME", Some("correction"), 0),
        (None, "REGULAR", None, 1),
    ] {
        let mut p = person("E-2", "김민수", "ACTIVE");
        p.employment_type = stored.map(str::to_owned);
        let world = World::new(vec![p]);
        let mut input = row("kind", Some("E-2"), "김민수");
        input.employment_type = Some(incoming.into());
        let planned = world.plan(&[input], &Decisions::default());
        assert_eq!(
            planned[0]
                .deferred
                .iter()
                .find(|d| d.field == "employment_type")
                .map(|d| d.route),
            route
        );
        assert_eq!(
            planned[0]
                .diff
                .iter()
                .filter(|d| d.field == "employment_type")
                .count(),
            changes
        );
    }
}

#[test]
fn namesake_candidates_exclude_a_contradicting_birth_date() {
    let mut a = person("A", "김민수", "ACTIVE");
    let mut b = person("B", "김민수", "ACTIVE");
    a.birth_date = Some(time::macros::date!(1990 - 01 - 01));
    b.birth_date = Some(time::macros::date!(1991 - 01 - 01));
    let expected = a.id;
    let world = World::new(vec![a, b]);
    let mut input = row("namesake", None, "김민수");
    input.birth_date = Some("1990-01-01".into());
    let planned = world.plan(&[input], &Decisions::default());
    assert_eq!(
        planned[0]
            .candidates
            .iter()
            .map(|c| c.employee_id)
            .collect::<Vec<_>>(),
        vec![expected]
    );
}

#[test]
fn existing_rows_keep_replay_metadata_and_never_exit_an_already_exited_person() {
    let mut p = person("E-2", "김민수", "EXITED");
    p.aliases.push("OLD-2".into());
    p.exit_date = Some(time::macros::date!(2025 - 01 - 01));
    let observed = p.observed.clone();
    let world = World::new(vec![p]);
    let mut input = row("former", Some("OLD-2"), "김민수");
    input.exit_date = Some("2025-01-01".into());
    let planned = world.plan(&[input], &Decisions::default());
    assert_eq!(planned[0].employee_number.as_deref(), Some("E-2"));
    assert_eq!(planned[0].observed.as_deref(), Some(observed.as_str()));
    assert!(planned[0].deferred.iter().all(|d| d.route != "exit_case"));
}

#[test]
fn a_stated_status_stays_unchanged_or_requires_its_own_flow() {
    for (stored, incoming, route) in [
        ("ACTIVE", "ACTIVE", None),
        ("ACTIVE", "ON_LEAVE", Some("leave")),
        ("ON_LEAVE", "ACTIVE", Some("lifecycle")),
        ("EXITED", "ACTIVE", Some("rehire")),
    ] {
        let p = person("E-2", "김민수", stored);
        let world = World::new(vec![p]);
        let mut input = row("status", Some("E-2"), "김민수");
        input.status = Some(incoming.into());
        let planned = world.plan(&[input], &Decisions::default());
        assert_eq!(
            planned[0]
                .deferred
                .iter()
                .find(|d| d.field == "employment_status")
                .map(|d| d.route),
            route
        );
    }
}
