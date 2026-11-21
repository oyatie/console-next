// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::panic)]

use console_hr_domain::import::detect::{ColumnPlan, MappingSource};
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet};
use uuid::Uuid;

use super::sheet::{SheetContext, sheet_rows};

fn cell_text(v: &str) -> Cell {
    Cell::Text(v.into())
}

fn grid(name: &str, cells: &[(u32, u32, Cell)]) -> GridSheet {
    let mut rows: Vec<GridRow> = Vec::new();
    for (row, col, cell) in cells {
        match rows.iter_mut().find(|r| r.index == *row) {
            Some(r) => r.cells.push((*col, cell.clone())),
            None => rows.push(GridRow {
                index: *row,
                cells: vec![(*col, cell.clone())],
            }),
        }
    }
    rows.sort_by_key(|r| r.index);
    GridSheet {
        name: name.into(),
        rows,
    }
}

#[test]
fn sheet_rows_strips_disallowed_restricted_targets_before_reading_cells() {
    use console_hr_domain::import::classification::employee_import_field_for_target;
    let name = employee_import_field_for_target("name").unwrap().aliases[0];
    let account = "account_no";
    let salary = "salary";
    let sheet = grid(
        "s",
        &[
            (0, 0, cell_text(name)),
            (0, 1, cell_text(account)),
            (0, 2, cell_text(salary)),
            (1, 0, cell_text("Alice")),
            (1, 1, cell_text("110-123-456789")),
            (1, 2, cell_text("5000000")),
        ],
    );
    let plans = vec![
        ColumnPlan {
            column: 0,
            label: name.to_owned(),
            target: Some("name"),
            source: MappingSource::Operator,
        },
        ColumnPlan {
            column: 1,
            label: account.to_owned(),
            target: Some("position"),
            source: MappingSource::Operator,
        },
        ColumnPlan {
            column: 2,
            label: salary.to_owned(),
            target: Some("job"),
            source: MappingSource::Operator,
        },
    ];
    let ctx = SheetContext {
        filename: "f.xlsx",
        org: Uuid::nil(),
        vault: None,
    };
    let out = sheet_rows(&ctx, &sheet, 0, &plans, "operator");
    assert_eq!(out.columns[1].target, None);
    assert_eq!(out.columns[1].classification, "restricted");
    assert!(!out.columns[1].preview_allowed);
    assert_eq!(out.columns[2].target, None);
    assert_eq!(out.columns[2].classification, "restricted");
    assert!(!out.columns[2].preview_allowed);
    let canonical = out.rows[0].canonical.as_ref().unwrap();
    assert_eq!(canonical.position, None);
    assert_eq!(canonical.job, None);
    let raw = out.rows[0].raw_row.to_string();
    let meta = out.rows[0].source_metadata.to_string();
    assert!(!raw.contains("110-123-456789") && !meta.contains("110-123-456789"));
    assert!(!raw.contains("5000000") && !meta.contains("5000000"));
}
