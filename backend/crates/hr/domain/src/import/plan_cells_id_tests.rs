// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;
use time::{Date, Month};

use super::super::cells::{DateParseError, parse_import_date_checked};
use super::super::numbering::Numbering;
use super::super::plan::{Decisions, ImportRow, OnFile, PlanFacts};
use super::super::plan_rows::plan_rows;
use super::super::review::review_queue;
use super::super::rrn_value::Rrn;

fn day(y: i32, m: u8, d: u8) -> Date {
    Date::from_calendar_date(y, Month::try_from(m).unwrap(), d).unwrap()
}

fn empty_row(key: &str) -> ImportRow {
    ImportRow {
        source_key: key.into(),
        sheet: "Sheet1".into(),
        row: 2,
        name: "Alex Kim".into(),
        company: "Acme".into(),
        hire_date: Some("2026-12-01".into()),
        ..ImportRow::default()
    }
}

#[test]
fn parse_import_date_checked_distinguishes_two_digit_years() {
    assert_eq!(parse_import_date_checked("2026-03-04"), Ok(day(2026, 3, 4)));
    for raw in ["24-03-04", "24.03.04", "24/3/4", "24년 3월 4일"] {
        assert_eq!(
            parse_import_date_checked(raw),
            Err(DateParseError::TwoDigitYear),
            "{raw}"
        );
    }
    assert_eq!(
        parse_import_date_checked("2024-02-30"),
        Err(DateParseError::InvalidFormat)
    );
}

#[test]
fn mod11_validates_arc_and_domestic_residence_check_digits() {
    let valid = Rrn::parse("900101-5000014").unwrap();
    assert!(valid.passes_mod11());
    let invalid = Rrn::parse("900101-5000010").unwrap();
    assert!(!invalid.passes_mod11());
}

#[test]
fn pre_hire_not_issued_enforces_status_secondary_key_and_uniqueness() {
    let company_workplaces = BTreeMap::new();
    let units = BTreeMap::new();
    let unit_workplaces = BTreeMap::new();
    let workplaces = BTreeMap::new();
    let numbering = Numbering::default();
    let existing = [OnFile {
        id: uuid::Uuid::new_v4(),
        name: "Sam Park".into(),
        status: "PRE_HIRE".into(),
        birth_date: Some(day(1995, 5, 5)),
        id_type: Some("NOT_ISSUED".into()),
        ..OnFile::default()
    }];
    let facts = PlanFacts {
        company_workplaces: &company_workplaces,
        people: &existing,
        units: &units,
        unit_workplaces: &unit_workplaces,
        workplaces: &workplaces,
        today: day(2026, 11, 22),
        former_load_open: true,
        numbering: &numbering,
    };

    // Valid PRE_HIRE + NOT_ISSUED with birth_date
    let mut prehire = empty_row("r1");
    prehire.id_type = Some("NOT_ISSUED".into());
    prehire.birth_date = Some("1994-01-01".into());
    let plan = plan_rows(&[prehire.clone()], &facts, &Decisions::default());
    assert_eq!(plan[0].outcome, "insert");
    assert_eq!(
        plan[0]
            .new_person
            .as_ref()
            .and_then(|p| p.id_type.as_deref()),
        Some("NOT_ISSUED")
    );

    // ACTIVE + NOT_ISSUED refused
    let mut active = prehire.clone();
    active.hire_date = Some("2025-01-01".into());
    let plan = plan_rows(&[active], &facts, &Decisions::default());
    assert_eq!(plan[0].outcome, "refused");
    assert_eq!(plan[0].refusal_code, Some("not_issued_requires_pre_hire"));

    // NOT_ISSUED + RRN refused
    let mut with_rrn = prehire.clone();
    with_rrn.has_rrn = true;
    let plan = plan_rows(&[with_rrn], &facts, &Decisions::default());
    assert_eq!(plan[0].refusal_code, Some("not_issued_with_rrn"));

    // NOT_ISSUED without birth_date and without employee_number refused
    let mut missing_sec = empty_row("r2");
    missing_sec.id_type = Some("NOT_ISSUED".into());
    let plan = plan_rows(&[missing_sec], &facts, &Decisions::default());
    assert_eq!(
        plan[0].refusal_code,
        Some("not_issued_secondary_key_required")
    );

    // Duplicate in file for (name_key, birth_date) under NOT_ISSUED
    let mut dup_a = prehire.clone();
    dup_a.name = "김 예정".into();
    let mut dup_b = prehire;
    dup_b.source_key = "r3".into();
    dup_b.name = "김예정".into();
    let plan = plan_rows(&[dup_a, dup_b], &facts, &Decisions::default());
    assert_eq!(plan[0].refusal_code, Some("duplicate_in_file"));
    assert_eq!(plan[1].refusal_code, Some("duplicate_in_file"));
}

#[test]
fn two_digit_year_surfaces_inline_cell_repair_and_resolves() {
    let company_workplaces = BTreeMap::new();
    let units = BTreeMap::new();
    let unit_workplaces = BTreeMap::new();
    let workplaces = BTreeMap::new();
    let numbering = Numbering::default();
    let facts = PlanFacts {
        company_workplaces: &company_workplaces,
        people: &[],
        units: &units,
        unit_workplaces: &unit_workplaces,
        workplaces: &workplaces,
        today: day(2026, 11, 22),
        former_load_open: true,
        numbering: &numbering,
    };

    let mut row = empty_row("r1");
    row.birth_date = Some("90-01-01".into());
    let planned = plan_rows(&[row.clone()], &facts, &Decisions::default());
    assert_eq!(planned[0].outcome, "refused");
    assert_eq!(planned[0].refusal_code, Some("two_digit_year"));
    assert_eq!(planned[0].refusal_field, Some("birth_date"));

    let cell = |_k: &str, f: &str| Some(format!("{f}_cell"));
    let queue = review_queue(&[row.clone()], &planned, &[], &cell);
    assert_eq!(queue.items[0].reason, "two_digit_year");
    assert_eq!(queue.items[0].expected_format, Some("YYYY-MM-DD"));
    assert_eq!(
        queue.items[0].resolution.as_ref().map(|r| r.decision),
        Some("cells")
    );

    let mut decisions = Decisions::default();
    decisions
        .cells
        .entry("r1".into())
        .or_default()
        .insert("birth_date".into(), "1990-01-01".into());
    let fixed = plan_rows(&[row], &facts, &decisions);
    assert_eq!(fixed[0].outcome, "insert");
    assert_eq!(
        fixed[0]
            .new_person
            .as_ref()
            .and_then(|p| p.birth_date.as_deref()),
        Some("1990-01-01")
    );
}

#[test]
fn domestic_residence_and_foreigner_reg_pairs_validate_cleanly() {
    let company_workplaces = BTreeMap::new();
    let units = BTreeMap::new();
    let unit_workplaces = BTreeMap::new();
    let workplaces = BTreeMap::new();
    let numbering = Numbering::default();
    let facts = PlanFacts {
        company_workplaces: &company_workplaces,
        people: &[],
        units: &units,
        unit_workplaces: &unit_workplaces,
        workplaces: &workplaces,
        today: day(2026, 11, 22),
        former_load_open: true,
        numbering: &numbering,
    };

    let mut ok_row = empty_row("r1");
    ok_row.hire_date = Some("2025-01-01".into());
    ok_row.id_type = Some("DOMESTIC_RESIDENCE".into());
    ok_row.inferred_id_type = Some("ARC".into());
    let planned = plan_rows(&[ok_row], &facts, &Decisions::default());
    assert_eq!(planned[0].outcome, "insert");
    assert_eq!(
        planned[0]
            .new_person
            .as_ref()
            .and_then(|p| p.id_type.as_deref()),
        Some("DOMESTIC_RESIDENCE")
    );

    let mut alias_row = empty_row("r2");
    alias_row.hire_date = Some("2025-01-01".into());
    alias_row.id_type = Some("FOREIGNER_REG".into());
    alias_row.inferred_id_type = Some("ARC".into());
    let planned = plan_rows(&[alias_row], &facts, &Decisions::default());
    assert_eq!(
        planned[0]
            .new_person
            .as_ref()
            .and_then(|p| p.id_type.as_deref()),
        Some("ARC")
    );

    let mut bad_pair = empty_row("r3");
    bad_pair.hire_date = Some("2025-01-01".into());
    bad_pair.id_type = Some("RRN".into());
    bad_pair.inferred_id_type = Some("ARC".into());
    let planned = plan_rows(&[bad_pair], &facts, &Decisions::default());
    assert_eq!(planned[0].refusal_code, Some("id_type_rrn_mismatch"));
}
