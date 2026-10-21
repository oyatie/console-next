use std::path::{Path, PathBuf};

pub fn master_list_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../rest/tests/fixtures/master-list.xlsx")
}

pub fn copy_master_list(filename: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "console-registry-test-{}-{}",
        std::process::id(),
        filename
    ));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join(filename);
    std::fs::copy(master_list_path(), &target).unwrap();
    target
}

pub fn rewrite_cell(path: &Path, sheet: &str, cell: &str, value: &str) {
    let mut workbook = umya_spreadsheet::reader::xlsx::read(path).unwrap();
    let sheet = workbook
        .sheet_by_name_mut(sheet)
        .expect("sheet should exist");
    for row in 4..=447 {
        sheet
            .cell_mut((2, row))
            .set_value_string(format!("{:03}", row - 3));
    }
    sheet.cell_mut(cell).set_value(value);
    umya_spreadsheet::writer::xlsx::write(&workbook, path).unwrap();
}
