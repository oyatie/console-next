//! IMPORT-2 item 0: the one way an uploaded `.xlsx` becomes sheets. The
//! container is walked and its real inflated size counted first
//! (`guard::zip::scan_zip`), then each sheet streams through calamine's cell
//! reader under the box and cell caps; `worksheet_range` (which allocates the
//! declared box) is never called. Runs on a blocking thread.

use std::io::Cursor;

use calamine::{DataRef, DataType, Reader, Xlsx};
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet};
use console_hr_domain::import::guard::zip::scan_zip;
use console_hr_domain::import::guard::{CellBudget, WorkbookCaps};
use console_hr_domain::import::workbook::check_workbook_signature;
use http::StatusCode;

use super::HrError;

fn refused(code: &'static str, message: &str) -> HrError {
    HrError {
        status: StatusCode::UNPROCESSABLE_ENTITY,
        code,
        message: message.to_owned(),
        refusals: None,
    }
}

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
            let midnight = at.time() == chrono::NaiveTime::MIN;
            Cell::Text(if midnight {
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
) -> Result<GridSheet, HrError> {
    let unreadable = |_| refused("workbook", "a worksheet could not be read");
    let mut reader = book.worksheet_cells_reader(name).map_err(unreadable)?;
    let dims = reader.dimensions();
    let declared = |a: u32, b: u32| u64::from(b.saturating_sub(a)) + 1;
    budget
        .check_box(
            declared(dims.start.0, dims.end.0),
            declared(dims.start.1, dims.end.1),
        )
        .map_err(|code| refused(code, "a worksheet is larger than the import accepts"))?;
    let (mut rows, mut max_row, mut max_col) = (Vec::<GridRow>::new(), 0u32, 0u32);
    while let Some(next) = reader.next_cell().map_err(unreadable)? {
        let Some(value) = cell(next.get_value()) else {
            continue;
        };
        let (row, col) = next.get_position();
        budget
            .count()
            .map_err(|code| refused(code, "the workbook has more cells than the import accepts"))?;
        (max_row, max_col) = (max_row.max(row), max_col.max(col));
        budget
            .check_box(u64::from(max_row) + 1, u64::from(max_col) + 1)
            .map_err(|code| refused(code, "a worksheet is larger than the import accepts"))?;
        match rows.last_mut() {
            Some(last) if last.index == row => last.cells.push((col, value)),
            _ => rows.push(GridRow {
                index: row,
                cells: vec![(col, value)],
            }),
        }
    }
    // The XML is row-major in practice; sort anyway so lookups can bisect.
    rows.sort_by_key(|row| row.index);
    for row in &mut rows {
        row.cells.sort_by_key(|(col, _)| *col);
    }
    Ok(GridSheet {
        name: name.to_owned(),
        rows,
    })
}

/// Every sheet of the workbook, in workbook order.
///
/// # Errors
/// 422 `workbook_protected` / `workbook_not_xlsx` for a non-ZIP, one of the
/// `guard::codes` refusals past a cap, 422 `workbook` for a damaged file.
pub fn read_workbook(bytes: &[u8], caps: &WorkbookCaps) -> Result<Vec<GridSheet>, HrError> {
    check_workbook_signature(bytes).map_err(|code| {
        let message = if code == "workbook_protected" {
            "the workbook is password- or DRM-protected; remove the protection and upload it again"
        } else {
            "the file is not an .xlsx workbook"
        };
        refused(code, message)
    })?;
    scan_zip(bytes, caps)
        .map_err(|code| refused(code, "the workbook is larger than the import accepts"))?;
    let mut book = Xlsx::new(Cursor::new(bytes))
        .map_err(|_| refused("workbook", "the workbook could not be read"))?;
    let mut budget = CellBudget::new(*caps);
    let names = book.sheet_names().clone();
    names
        .iter()
        .map(|name| read_sheet(&mut book, name, &mut budget))
        .collect()
}

/// [`read_workbook`] on a blocking thread, so a large file never stalls the
/// async runtime.
pub async fn read_workbook_blocking(
    bytes: Vec<u8>,
    caps: WorkbookCaps,
) -> Result<Vec<GridSheet>, HrError> {
    tokio::task::spawn_blocking(move || read_workbook(&bytes, &caps))
        .await
        .map_err(|_| HrError::internal("workbook reader stopped"))?
}

#[cfg(test)]
#[path = "workbook_read_tests.rs"]
mod tests;
