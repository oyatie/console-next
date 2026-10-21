//! An uploaded `.xlsx` becoming sheets, then header detection on each sheet.
//! `read` mirrors `app/src/hr/workbook_read.rs` (private to console-app): the
//! domain guards and vendored calamine are the real code under test; keep the
//! loop in step with that file. Invariants: never panic, never allocate past
//! the caps (libFuzzer's -rss_limit_mb catches that), and every sheet that
//! reads stays inside the grid cap.
#![no_main]

use std::collections::BTreeMap;
use std::io::Cursor;

use calamine::{DataRef, DataType, Reader, Xlsx};
use console_hr_domain::import::detect::detect;
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet};
use console_hr_domain::import::guard::zip::scan_zip;
use console_hr_domain::import::guard::{CellBudget, WorkbookCaps};
use console_hr_domain::import::workbook::check_workbook_signature;
use libfuzzer_sys::fuzz_target;

/// The shipped defaults (migration 0296: import.upload.max_mib … workbook.max_cells).
const CAPS: WorkbookCaps = WorkbookCaps {
    max_upload_bytes: 16 << 20,
    max_entries: 1000,
    max_expanded_bytes: 128 << 20,
    max_ratio: 200,
    max_grid_cells: 5_000_000,
    max_cells: 2_000_000,
};

fn cell(value: &DataRef<'_>) -> Option<Cell> {
    let text = |s: &str| (!s.trim().is_empty()).then(|| Cell::Text(s.to_owned()));
    match value {
        DataRef::Empty => None,
        DataRef::Int(v) => Some(Cell::Int(*v)),
        DataRef::Float(v) => Some(Cell::Float(*v)),
        DataRef::Bool(v) => Some(Cell::Bool(*v)),
        DataRef::String(s) => text(s),
        DataRef::SharedString(s) => text(s),
        DataRef::DateTime(_) => value.as_datetime().map(|at| {
            let day = at.date().format("%Y-%m-%d").to_string();
            Cell::Text(if at.time() == chrono::NaiveTime::MIN {
                day
            } else {
                at.format("%Y-%m-%d %H:%M:%S").to_string()
            })
        }),
        DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => text(s),
        DataRef::Error(e) => Some(Cell::Text(e.to_string())),
    }
}

fn read_sheet(
    book: &mut Xlsx<Cursor<&[u8]>>,
    name: &str,
    budget: &mut CellBudget,
) -> Result<GridSheet, &'static str> {
    let mut reader = book.worksheet_cells_reader(name).map_err(|_| "workbook")?;
    let dims = reader.dimensions();
    let declared = |a: u32, b: u32| u64::from(b.saturating_sub(a)) + 1;
    budget.check_box(
        declared(dims.start.0, dims.end.0),
        declared(dims.start.1, dims.end.1),
    )?;
    let (mut rows, mut max_row, mut max_col) = (Vec::<GridRow>::new(), 0u32, 0u32);
    while let Some(next) = reader.next_cell().map_err(|_| "workbook")? {
        let Some(value) = cell(next.get_value()) else {
            continue;
        };
        let (row, col) = next.get_position();
        budget.count()?;
        (max_row, max_col) = (max_row.max(row), max_col.max(col));
        budget.check_box(u64::from(max_row) + 1, u64::from(max_col) + 1)?;
        match rows.last_mut() {
            Some(last) if last.index == row => last.cells.push((col, value)),
            _ => rows.push(GridRow {
                index: row,
                cells: vec![(col, value)],
            }),
        }
    }
    rows.sort_by_key(|row| row.index);
    for row in &mut rows {
        row.cells.sort_by_key(|(col, _)| *col);
    }
    Ok(GridSheet {
        name: name.to_owned(),
        rows,
    })
}

fn read(bytes: &[u8]) -> Result<Vec<GridSheet>, &'static str> {
    check_workbook_signature(bytes)?;
    scan_zip(bytes, &CAPS)?;
    let mut book = Xlsx::new(Cursor::new(bytes)).map_err(|_| "workbook")?;
    let mut budget = CellBudget::new(CAPS);
    let names = book.sheet_names().clone();
    names
        .iter()
        .map(|name| read_sheet(&mut book, name, &mut budget))
        .collect()
}

fuzz_target!(|bytes: &[u8]| {
    let Ok(sheets) = read(bytes) else { return };
    let mut cells = 0u64;
    for sheet in &sheets {
        cells += sheet.rows.iter().map(|r| r.cells.len() as u64).sum::<u64>();
        let _ = detect(sheet, &BTreeMap::new(), None);
    }
    assert!(cells <= CAPS.max_cells, "{cells} cells read past the cap");
});
