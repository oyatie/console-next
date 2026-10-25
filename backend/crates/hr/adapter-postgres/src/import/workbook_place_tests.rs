// SPDX-License-Identifier: LicenseRef-Proprietary
//! Catalog header defaults depend on the tenant's workplace values.
#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;

use serde_json::json;
use uuid::Uuid;

use super::refine_place_columns;
use crate::import::parsed::{
    ImportRowStatus, ParsedEmployeeImportRow, ParsedEmployeeImportWorkbook,
};
use crate::import::types::EmployeeImportColumn;

fn workbook(values: &[&str], source: &str) -> ParsedEmployeeImportWorkbook {
    let report = json!({
        "name": "직원", "status": "mapped", "header_row": 1, "rows": values.len(),
        "columns": [{ "column": "B", "label": "사업장", "target": "workplace", "source": source }],
    });
    ParsedEmployeeImportWorkbook {
        sheets: vec![report.clone()],
        shown: vec![report],
        columns: vec![EmployeeImportColumn {
            source_header: "사업장".into(),
            normalized_header: "사업장".into(),
            target: Some("workplace".into()),
            classification: "canonical".into(),
            preview_allowed: true,
            notice: None,
            place_reading_required: None,
        }],
        rows: values
            .iter()
            .enumerate()
            .map(|(index, value)| ParsedEmployeeImportRow {
                company: String::new(),
                name: Some(format!("직원{index}")),
                source_filename: "직원.xlsx".into(),
                source_sheet: "직원".into(),
                source_row: i32::try_from(index + 2).unwrap(),
                source_key: format!("직원:{index}"),
                row_status: ImportRowStatus::Candidate,
                canonical: Some(
                    serde_json::from_value(json!({
                        "workplace": value, "worksite_name": "고객현장",
                    }))
                    .unwrap(),
                ),
                raw_row: json!({"사업장": value}),
                source_metadata: json!({}),
            })
            .collect(),
        ..Default::default()
    }
}

fn workplaces() -> BTreeMap<String, Vec<Uuid>> {
    BTreeMap::from([
        ("본사".into(), vec![Uuid::new_v4()]),
        ("판교지점".into(), vec![Uuid::new_v4()]),
    ])
}

#[test]
fn place_columns_bind_exact_and_normalized_values_but_ignore_blanks() {
    let mut parsed = workbook(&["본사", "판교 지점", ""], "catalog");
    refine_place_columns(&mut parsed, &workplaces());
    assert_eq!(parsed.sheets[0]["status"], "mapped");
    assert_eq!(parsed.shown[0]["columns"][0]["target"], "workplace");
    assert_eq!(parsed.columns[0].target.as_deref(), Some("workplace"));
    assert_eq!(parsed.columns[0].notice, None);
    assert!(parsed.notes.is_empty());
    let canonical = serde_json::to_value(&parsed.rows[1].canonical).unwrap();
    assert_eq!(canonical["workplace"], "판교 지점");
}

#[test]
fn place_columns_require_an_operator_reading_for_unknown_or_mixed_values() {
    for values in [&["고객현장"][..], &["본사", "고객현장"][..]] {
        let mut parsed = workbook(values, "catalog");
        refine_place_columns(&mut parsed, &workplaces());
        refine_place_columns(&mut parsed, &workplaces());
        for report in parsed.sheets.iter().chain(&parsed.shown) {
            assert_eq!(report["status"], "needs_mapping");
            assert_eq!(report["header_row"], 1);
            assert_eq!(report["columns"][0]["column"], "B");
            assert_eq!(report["columns"][0]["target"], json!(null));
        }
        assert_eq!(parsed.columns[0].target, None);
        assert_eq!(parsed.columns[0].notice, None);
        assert_eq!(parsed.columns[0].place_reading_required, Some(true));
        assert_eq!(parsed.notes.len(), 1);
        assert!(parsed.notes[0].blocking);
        assert_eq!(parsed.notes[0].reason, "sheet_needs_mapping");
        for row in &parsed.rows {
            let canonical = serde_json::to_value(&row.canonical).unwrap();
            assert_eq!(canonical["workplace"], json!(null));
            assert_eq!(canonical["worksite_name"], "고객현장");
        }
    }
}

#[test]
fn place_columns_preserve_operator_and_remembered_readings() {
    for source in ["operator", "remembered"] {
        let mut parsed = workbook(&["고객현장"], source);
        refine_place_columns(&mut parsed, &workplaces());
        assert_eq!(parsed.sheets[0]["status"], "mapped");
        assert_eq!(parsed.sheets[0]["columns"][0]["target"], "workplace");
        assert_eq!(parsed.columns[0].notice, None);
        assert!(parsed.notes.is_empty());
        let canonical = serde_json::to_value(&parsed.rows[0].canonical).unwrap();
        assert_eq!(canonical["workplace"], "고객현장");
    }
}

#[test]
fn place_columns_use_only_the_current_tenants_workplaces() {
    let mut matching = workbook(&["本社"], "catalog");
    let mut other = matching.clone();
    let tenant = BTreeMap::from([("本社".into(), vec![Uuid::new_v4()])]);
    refine_place_columns(&mut matching, &tenant);
    refine_place_columns(&mut other, &workplaces());
    assert_eq!(matching.sheets[0]["status"], "mapped");
    assert_eq!(other.sheets[0]["status"], "needs_mapping");
}

#[test]
fn place_columns_keep_ambiguous_normalized_names_unmapped() {
    let mut parsed = workbook(&["판교-지점"], "catalog");
    let tenant = BTreeMap::from([
        ("판교지점".into(), vec![Uuid::new_v4()]),
        ("판교 지점".into(), vec![Uuid::new_v4()]),
    ]);
    refine_place_columns(&mut parsed, &tenant);
    assert_eq!(parsed.sheets[0]["status"], "needs_mapping");
    assert_eq!(parsed.columns[0].notice, None);
    assert_eq!(parsed.columns[0].place_reading_required, Some(true));
}
