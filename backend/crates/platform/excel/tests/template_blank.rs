// SPDX-License-Identifier: LicenseRef-Proprietary
//! The shipped templates carry labels only. An export copies the whole template workbook, so a value left in it
//! (another day's work, a person, a price) reaches every tenant that exports. Regression for the templates that
//! were the customer's filled-in workbooks.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Cursor;

use console_platform_excel::{
    DAILY_STATUS_TEMPLATE, DAILY_STATUS_TEMPLATE_XLSX, WORK_DIARY_TEMPLATE_XLSX, umya_spreadsheet,
};

/// Every cell that holds a value, as (column, row).
fn filled(bytes: &[u8]) -> Vec<(u32, u32)> {
    let book = umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(bytes), true).unwrap();
    assert_eq!(book.sheet_collection().len(), 1, "a template has one sheet");
    let sheet = &book.sheet_collection()[0];
    let mut cells: Vec<_> = sheet
        .cells_sorted()
        .into_iter()
        .filter(|cell| !cell.value().to_string().trim().is_empty())
        .map(|cell| {
            let at = cell.coordinate();
            (at.col_num(), at.row_num())
        })
        .collect();
    cells.sort_unstable_by_key(|&(col, row)| (row, col));
    cells
}

#[test]
fn the_daily_status_template_holds_its_title_section_headers_and_legend_only() {
    let cells = filled(DAILY_STATUS_TEMPLATE_XLSX);
    for section in DAILY_STATUS_TEMPLATE.sections() {
        let data = section.first_data_row()..=section.last_data_row();
        assert!(
            cells.iter().all(|(_, row)| !data.contains(row)),
            "{} has a value in its data rows",
            section.title()
        );
    }
    let label_rows = [1, 2, 3, 24, 25, 44, 45, 77, 78, 94, 95, 96, 97];
    assert!(cells.iter().all(|(_, row)| label_rows.contains(row)));
    assert_eq!(cells.len(), 60);
}

#[test]
fn the_work_diary_template_holds_its_headings_only() {
    let cells = filled(WORK_DIARY_TEMPLATE_XLSX);
    let headings = [
        (2, 1),
        (2, 2),
        (2, 3),
        (2, 5),
        (2, 8),
        (6, 8),
        (2, 9),
        (6, 9),
        (2, 14),
        (6, 14),
        (6, 32),
    ];
    let mut expected = headings.to_vec();
    expected.sort_unstable_by_key(|&(col, row)| (row, col));
    assert_eq!(cells, expected);
}
