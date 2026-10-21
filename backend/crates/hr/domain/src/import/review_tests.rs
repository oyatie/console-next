//! The queue over hand-made plan rows (values are made up).
#![allow(clippy::unwrap_used)]

use uuid::Uuid;

use super::*;
use crate::import::plan::{Candidate, Deferred, NewPerson};

fn plan(
    key: &str,
    outcome: &'static str,
    code: Option<&'static str>,
    field: Option<&'static str>,
) -> PlannedRow {
    PlannedRow {
        source_key: key.into(),
        sheet: "명부".into(),
        row: 3,
        name: "가".into(),
        outcome,
        employee_id: None,
        employee_number: None,
        observed: None,
        diff: Vec::new(),
        deferred: Vec::new(),
        new_person: None,
        refusal_code: code,
        refusal_field: field,
        unit_name: None,
        workplace_name: None,
        candidates: Vec::new(),
        exclusion_code: None,
        matched_by: None,
    }
}

fn new_person(number: Option<&str>) -> NewPerson {
    NewPerson {
        employee_number: number.map(Into::into),
        status: "ACTIVE",
        hire_date: "2024-01-01".into(),
        exit_date: None,
        birth_date: None,
        org_unit: None,
        org_unit_id: None,
        migrated_former: false,
        workplace_id: None,
        employment_type: None,
        unresolved_org_unit: None,
        employee_number_source: None,
        leave: None,
        unplaced_reason: None,
        sex: None,
        contract_end_date: None,
        probation_end_date: None,
    }
}

#[test]
fn every_item_names_its_reason_cell_and_resolution_and_values_are_grouped() {
    let candidate = Uuid::new_v4();
    let mut waiting = plan("a", "unresolved_identity", None, None);
    waiting.candidates.push(Candidate {
        employee_id: candidate,
        employee_number: Some("E-1".into()),
        status: "ACTIVE".into(),
        basis: "name_only",
        company: "Co".into(),
        org_unit: None,
        birth_date_masked: None,
    });
    let bad_date = plan("b", "refused", Some("invalid_date"), Some("hire_date"));
    let status = plan(
        "c",
        "refused",
        Some("status_unmapped"),
        Some("employment_status"),
    );
    let status_again = plan(
        "d",
        "refused",
        Some("status_unmapped"),
        Some("employment_status"),
    );
    let mut unplaced = plan("e", "insert", None, None);
    unplaced.unit_name = Some("총무팀".into());
    unplaced.new_person = Some(new_person(None));
    unplaced.deferred.push(Deferred {
        field: "employment_type",
        from: None,
        to: Some("촉탁".into()),
        route: "value_map",
    });
    let plans = [waiting, bad_date, status, status_again, unplaced];
    let rows: Vec<ImportRow> = plans
        .iter()
        .map(|p| ImportRow {
            source_key: p.source_key.clone(),
            status: Some("파견".into()),
            ..ImportRow::default()
        })
        .collect();
    let notes = [Note {
        reason: "sheet_needs_mapping",
        blocking: true,
        sheet: "업무일지".into(),
        row: None,
        cell: None,
    }];
    let cell = |key: &str, field: &str| Some(format!("{key}:{field}"));
    let queue = review_queue(&rows, &plans, &notes, &cell);
    let reasons: Vec<_> = queue
        .items
        .iter()
        .map(|i| (i.reason, i.blocking, i.rows))
        .collect();
    assert_eq!(
        reasons,
        [
            ("sheet_needs_mapping", true, 1),
            ("unresolved_identity", true, 1),
            ("invalid_date", true, 1),
            ("status_unmapped", true, 2),
            ("employment_type_unmapped", true, 1),
            ("unit_unmapped", false, 1),
            ("employee_number_missing", false, 1),
        ]
    );
    assert_eq!((queue.count, queue.blocking), (7, 5));
    // W02: the likely code first, then every code; `null` is the empty answer.
    let kind = queue.items[4].resolution.as_ref().unwrap();
    assert_eq!(
        (kind.decision, kind.choices[0].as_str()),
        ("employment_type_map", "CONTRACT")
    );
    assert_eq!(kind.choices.len(), 9);
    let identity = queue.items[1].resolution.as_ref().unwrap();
    assert_eq!(identity.decision, "identity");
    assert_eq!(identity.choices, [candidate.to_string(), "new".into()]);
    assert_eq!(queue.items[2].cell.as_deref(), Some("b:hire_date"));
    let status = &queue.items[3];
    assert_eq!(status.value.as_deref(), Some("파견"));
    assert_eq!(status.resolution.as_ref().unwrap().decision, "status_map");
    let ids: std::collections::BTreeSet<_> = queue.items.iter().map(|i| &i.id).collect();
    assert_eq!(ids.len(), queue.count, "ids are unique");
}
