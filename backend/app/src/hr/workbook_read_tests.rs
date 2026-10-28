//! The bounded reader on real workbooks: the two backend reference samples
//! (shape only — no cell is asserted on or printed), synthetic ones, and
//! every cap. Values here are synthetic.
#![allow(clippy::unwrap_used)]

use super::*;
use console_hr_adapter_postgres::import::caps::default_caps;
use uuid::Uuid;

/// A sheet as `(name, [(row, column, value)])`, 0-based.
pub(crate) type Sheet<'a> = (&'a str, &'a [(u32, u32, &'a str)]);

pub(crate) fn xlsx(sheets: &[Sheet<'_>]) -> Vec<u8> {
    let mut book = umya_spreadsheet::new_file();
    for (i, (name, cells)) in sheets.iter().enumerate() {
        let sheet = if i == 0 {
            let sheet = book.sheet_by_name_mut("Sheet1").unwrap();
            sheet.set_name(*name);
            sheet
        } else {
            book.new_sheet(*name).unwrap()
        };
        for (row, col, value) in *cells {
            // umya is 1-based (column, row).
            match value.parse::<f64>() {
                Ok(number) => sheet.cell_mut((col + 1, row + 1)).set_value_number(number),
                Err(_) => sheet.cell_mut((col + 1, row + 1)).set_value(*value),
            };
        }
    }
    let mut out = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&book, &mut out).unwrap();
    out
}

fn reference_workbooks() -> Vec<Vec<u8>> {
    // The report templates: Excel-made workbooks kept in the repository.
    let dir = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../crates/platform/excel/templates"
    );
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "xlsx"))
        .collect();
    files.sort();
    files.iter().map(|p| std::fs::read(p).unwrap()).collect()
}

fn code(result: Result<Vec<GridSheet>, HrError>) -> &'static str {
    result.unwrap_err().code
}

#[test]
fn both_reference_workbooks_read_within_the_default_caps() {
    let caps = default_caps().unwrap();
    for book in reference_workbooks() {
        let sheets = read_workbook(&book, &caps).unwrap();
        assert!(!sheets.is_empty());
        assert!(sheets.iter().any(|sheet| !sheet.rows.is_empty()));
    }
    // One sheet each; the rows that hold a label (daily status, then work diary).
    let rows: Vec<Vec<usize>> = (reference_workbooks().iter())
        .map(|book| read_workbook(book, &caps).unwrap())
        .map(|sheets| sheets.iter().map(|sheet| sheet.rows.len()).collect())
        .collect();
    assert_eq!(rows, [vec![13], vec![8]]);
}

#[test]
fn cells_arrive_typed_in_row_then_column_order() {
    let book = xlsx(&[
        (
            "명부",
            &[
                (0, 0, "사번"),
                (0, 1, "성명"),
                (1, 0, "1001"),
                (1, 1, "김가나"),
            ],
        ),
        ("빈 시트", &[]),
    ]);
    let sheets = read_workbook(&book, &default_caps().unwrap()).unwrap();
    assert_eq!(sheets.len(), 2);
    assert_eq!(sheets[0].name, "명부");
    assert_eq!(sheets[0].rows[1].text(0), "1001");
    assert_eq!(sheets[0].rows[1].text(1), "김가나");
    assert!(sheets[1].rows.is_empty());
}

#[test]
fn inconsistent_zip_local_filenames_are_refused() {
    let original = xlsx(&[("명부", &[(0, 0, "성명"), (1, 0, "김가나")])]);
    let caps = default_caps().unwrap();
    assert_eq!(read_workbook(&original, &caps).unwrap()[0].rows.len(), 2);
    for name in [b"xl/workbook.xml".as_slice(), b"xl/worksheets/sheet1.xml"] {
        let mut book = original.clone();
        let header = book
            .windows(30 + name.len())
            .position(|bytes| bytes.starts_with(b"PK\x03\x04") && &bytes[30..] == name)
            .unwrap();
        // GHSA-m665-v7pm-7grj: keep the central name and payload intact.
        book[header + 30] = b'_';
        assert_eq!(code(read_workbook(&book, &caps)), "workbook");
    }
}

#[test]
fn a1_plus_xfd1048576_is_refused_before_anything_is_allocated() {
    let book = xlsx(&[("s", &[(0, 0, "a"), (1_048_575, 16_383, "b")])]);
    assert_eq!(
        code(read_workbook(&book, &default_caps().unwrap())),
        "sheet_grid_too_large"
    );
}

#[test]
fn every_cap_refuses_with_its_own_code() {
    let cells: Vec<(u32, u32, &str)> = (0..20).map(|r| (r, 0, "x")).collect();
    let book = xlsx(&[("s", &cells)]);
    let caps = default_caps().unwrap();
    let few_cells = WorkbookCaps {
        max_cells: 5,
        ..caps
    };
    assert_eq!(
        code(read_workbook(&book, &few_cells)),
        "workbook_too_many_cells"
    );
    let small = WorkbookCaps {
        max_expanded_bytes: 1_024,
        ..caps
    };
    assert_eq!(
        code(read_workbook(&book, &small)),
        "workbook_expands_too_far"
    );
    let few_entries = WorkbookCaps {
        max_entries: 2,
        ..caps
    };
    assert_eq!(
        code(read_workbook(&book, &few_entries)),
        "workbook_too_many_entries"
    );
    assert_eq!(
        code(read_workbook(b"name,phone\n", &caps)),
        "workbook_not_xlsx"
    );
}

#[tokio::test]
async fn the_blocking_reader_returns_the_same_sheets() {
    let book = xlsx(&[("s", &[(0, 0, "성명")])]);
    let caps = default_caps().unwrap();
    let sheets = read_workbook_blocking(book.clone(), caps).await.unwrap();
    assert_eq!(sheets, read_workbook(&book, &caps).unwrap());
}

/// The backend samples are work logs, not rosters: every sheet needs mapping
/// and stages nothing. A synthetic roster proves an explicit map stages a row.
#[test]
fn the_reference_workbooks_are_not_rosters_and_ask_for_a_mapping() {
    use console_hr_adapter_postgres::import::sheet::SheetContext;
    use console_hr_adapter_postgres::import::workbook::{mapping_request, parse_workbook};
    use console_hr_domain::import::detect::{SheetMappingRequest, WorkbookMappingRequest};
    let caps = default_caps().unwrap();
    let ctx = SheetContext {
        filename: "sample.xlsx",
        org: Uuid::nil(),
        vault: None,
    };
    let memory = Default::default();
    for book in reference_workbooks() {
        let sheets = read_workbook(&book, &caps).unwrap();
        let parsed =
            parse_workbook(&ctx, &sheets, &memory, &mapping_request(None).unwrap()).unwrap();
        assert!(parsed.rows.is_empty());
        assert!(parsed.sheets.iter().all(|s| s["status"] == "needs_mapping"));
        assert_eq!(parsed.notes.len(), sheets.len());
        assert!(
            parsed
                .notes
                .iter()
                .all(|n| n.blocking && n.reason == "sheet_needs_mapping")
        );
    }

    let sample = xlsx(&[("근무기록", &[(0, 0, "성명"), (1, 0, "김가나")])]);
    let sheets = read_workbook(&sample, &caps).unwrap();
    let mapping = WorkbookMappingRequest {
        sheets: [(
            "근무기록".to_owned(),
            SheetMappingRequest {
                header_row: Some(1),
                columns: [("A".to_owned(), Some("name".to_owned()))].into(),
                skip: None,
            },
        )]
        .into(),
    };
    let mapped = parse_workbook(&ctx, &sheets, &memory, &mapping).unwrap();
    assert_eq!(mapped.sheets[0]["status"], "mapped");
    assert_eq!(mapped.rows.len(), 1);
}

/// FZ-5 (`backend/fuzz`, minimised input committed under `fuzz/regressions`):
/// a `<dimension ref="B2:A1"/>` underflows in calamine's `get_dimension`, a
/// panic wherever overflow checks are on (dev and test builds). An upload is
/// refused or read, never a panic.
#[test]
#[ignore = "regression FZ-5 open, owner IMPORT: vendored calamine get_dimension underflows on a reversed dimension"]
fn regression_fz5_a_reversed_dimension_is_read_or_refused_without_panicking() {
    let book = include_bytes!("../../../fuzz/regressions/fz5-reversed-dimension.xlsx");
    let caps = default_caps().unwrap();
    let read = std::panic::catch_unwind(|| read_workbook(book, &caps).map(|s| s.len()).ok());
    assert!(read.is_ok(), "a reversed <dimension> panicked the reader");
}
