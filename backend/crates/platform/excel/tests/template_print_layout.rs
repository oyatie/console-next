// SPDX-License-Identifier: LicenseRef-Proprietary
//! The work-diary template keeps the base workbook's print layout: the print area and the repeated title row of its
//! one sheet. An export writes the template through the same workbook round-trip, so the names must survive it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Cursor;

use console_platform_excel::{
    WORK_DIARY_TEMPLATE_XLSX, roundtrip_workbook_bytes, umya_spreadsheet,
};

fn print_names(bytes: &[u8]) -> Vec<String> {
    let book = umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(bytes), true).unwrap();
    book.defined_names()
        .iter()
        .chain(
            book.sheet_collection()
                .iter()
                .flat_map(|sheet| sheet.defined_names()),
        )
        .map(|name| name.name().to_owned())
        .filter(|name| name.ends_with("Print_Area") || name.ends_with("Print_Titles"))
        .collect()
}

#[test]
fn the_work_diary_keeps_its_print_area_and_title_row_through_an_export_round_trip() {
    let template = print_names(WORK_DIARY_TEMPLATE_XLSX);
    let exported = print_names(&roundtrip_workbook_bytes(WORK_DIARY_TEMPLATE_XLSX).unwrap());
    for names in [&template, &exported] {
        assert!(names.iter().any(|n| n.ends_with("Print_Area")), "{names:?}");
        assert!(
            names.iter().any(|n| n.ends_with("Print_Titles")),
            "{names:?}"
        );
    }
}
