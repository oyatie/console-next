// SPDX-License-Identifier: LicenseRef-Proprietary
//! A person's confirmed column binding governs mixed workplace and site values.
#![allow(clippy::unwrap_used)]
use super::*;
use console_hr_domain::import::grid::{Cell, GridRow};
use uuid::Uuid;

#[test]
fn confirmed_place_bindings_preserve_mixed_values_and_unknowns_for_per_value_review() {
    for target in ["workplace", "worksite_name"] {
        let sheet = GridSheet {
            name: "Synthetic".into(),
            rows: [
                ["name", "workplace"],
                ["Synthetic person", "본사"],
                ["Another person", "고객 현장"],
            ]
            .iter()
            .enumerate()
            .map(|(index, cells)| GridRow {
                index: index as u32,
                cells: cells
                    .iter()
                    .enumerate()
                    .map(|(column, text)| (column as u32, Cell::Text((*text).into())))
                    .collect(),
            })
            .collect(),
        };
        let ctx = SheetContext {
            filename: "synthetic.xlsx",
            org: Uuid::nil(),
            vault: None,
        };
        let mapping = serde_json::from_value(json!({"sheets": {"Synthetic": {"header_row": 1, "columns": {"A": "name", "B": target}}}})).unwrap();
        let parsed = parse_workbook(&ctx, &[sheet], &BTreeMap::new(), &mapping).unwrap();
        assert_eq!(parsed.shown[0]["status"], "mapped");
        assert_eq!(
            parsed
                .columns
                .iter()
                .find(|c| c.source_header == "workplace")
                .unwrap()
                .target
                .as_deref(),
            Some(target)
        );
        assert_eq!(parsed.rows.len(), 2);
        for (row, expected) in parsed.rows.iter().zip(["본사", "고객 현장"]) {
            let canonical = serde_json::to_value(row.canonical.as_ref().unwrap()).unwrap();
            assert_eq!(canonical[target], expected);
            assert!(
                canonical[if target == "workplace" {
                    "worksite_name"
                } else {
                    "workplace"
                }]
                .is_null()
            );
        }
        assert!(parsed.notes.is_empty());
    }
}
