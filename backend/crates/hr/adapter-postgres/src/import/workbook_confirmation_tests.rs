// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::panic)]

use super::*;
use console_hr_domain::import::grid::{Cell, GridRow};
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use uuid::Uuid;

struct UnusedVault;
impl RrnVault for UnusedVault {
    fn seal(&self, _: Uuid, _: &Rrn) -> Result<SealedRrn, VaultError> {
        panic!("an unconfirmed column must never reach the vault")
    }
    fn blind_index(&self, _: &Rrn) -> Vec<u8> {
        panic!("an unconfirmed column must never reach the vault")
    }
    fn open(&self, _: Uuid, _: &SealedRrn) -> Result<Rrn, VaultError> {
        panic!("an unconfirmed column must never reach the vault")
    }
}

#[test]
fn unconfirmed_suggestions_never_read_cells_or_call_the_vault() {
    let sheet = GridSheet {
        name: "Synthetic".into(),
        rows: [
            ["name", "rrn", "phone", "position"],
            [
                "Synthetic person",
                "900101-1000000",
                "01012345678",
                "Synthetic title",
            ],
        ]
        .iter()
        .enumerate()
        .map(|(r, cells)| GridRow {
            index: r as u32,
            cells: cells
                .iter()
                .enumerate()
                .map(|(c, text)| (c as u32, Cell::Text((*text).into())))
                .collect(),
        })
        .collect(),
    };
    let ctx = SheetContext {
        filename: "synthetic.xlsx",
        org: Uuid::nil(),
        vault: Some(&UnusedVault),
    };
    let memory = BTreeMap::from([("position".into(), Some("position".into()))]);
    let ordinary = GridSheet {
        name: sheet.name.clone(),
        rows: sheet
            .rows
            .iter()
            .map(|row| GridRow {
                index: row.index,
                cells: row
                    .cells
                    .iter()
                    .filter(|(column, _)| *column == 0 || *column == 3)
                    .cloned()
                    .collect(),
            })
            .collect(),
    };
    for sheet in [sheet, ordinary] {
        for mapping in [
            WorkbookMappingRequest::default(),
            serde_json::from_value(json!({
                "sheets": {"Synthetic": {"header_row": 1, "columns": {"A": "name"}}}
            }))
            .unwrap(),
        ] {
            let parsed =
                parse_workbook(&ctx, std::slice::from_ref(&sheet), &memory, &mapping).unwrap();
            assert!(parsed.rows.is_empty());
            assert!(parsed.identities.is_empty());
            assert!(parsed.phones.is_empty());
            assert!(parsed.remembered.is_empty());
            assert_eq!(parsed.shown[0]["status"], "needs_mapping");
            assert_eq!(parsed.shown[0]["needs_confirmation"], true);
            assert_eq!(parsed.shown[0]["rows"], 1);
            assert_eq!(parsed.sheets[0]["rows"], 1);
            assert_eq!(
                parsed.shown[0]["columns"].as_array().unwrap().len(),
                sheet.rows[0].cells.len()
            );
            assert_eq!(parsed.notes.len(), 1);
            assert_eq!(parsed.notes[0].reason, "sheet_needs_mapping");
        }
    }
}

#[test]
fn confirmation_counts_only_nonblank_data_rows_without_staging_them() {
    let sheet = GridSheet {
        name: "Synthetic".into(),
        rows: vec![
            GridRow {
                index: 0,
                cells: vec![(0, Cell::Text("name".into()))],
            },
            GridRow {
                index: 1,
                cells: vec![(0, Cell::Text("Synthetic person".into()))],
            },
            GridRow {
                index: 3,
                cells: vec![(0, Cell::Text(" ".into()))],
            },
            GridRow {
                index: 8,
                cells: vec![(0, Cell::Text("Another person".into()))],
            },
        ],
    };
    let ctx = SheetContext {
        filename: "synthetic.xlsx",
        org: Uuid::nil(),
        vault: Some(&UnusedVault),
    };
    let parsed = parse_workbook(
        &ctx,
        &[sheet],
        &BTreeMap::new(),
        &WorkbookMappingRequest::default(),
    )
    .unwrap();
    assert_eq!(parsed.shown[0]["rows"], 2);
    assert_eq!(parsed.sheets[0]["status"], "needs_mapping");
    assert_eq!(parsed.sheets[0]["needs_confirmation"], true);
    assert!(parsed.rows.is_empty());
}
