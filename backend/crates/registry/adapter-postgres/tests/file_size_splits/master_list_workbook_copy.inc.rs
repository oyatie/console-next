fn copy_master_list(filename: &str) -> PathBuf {
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

fn rewrite_cell(path: &Path, sheet: &str, cell: &str, value: &str) {
    use calamine::{Data, Reader};

    let mut workbook = umya_spreadsheet::reader::xlsx::read(path).unwrap();
    // umya's reader re-types inline-string cells (zero-padded numbers become numbers);
    // restore every text cell so the copy differs from the original only at `cell`.
    let mut source = calamine::open_workbook_auto(path).unwrap();
    for name in source.sheet_names() {
        let range = source.worksheet_range(&name).unwrap();
        let (row0, col0) = range.start().unwrap_or_default();
        let target = workbook.sheet_by_name_mut(&name).unwrap();
        for (row, col, data) in range.used_cells() {
            if let Data::String(text) = data {
                let col = col0 + u32::try_from(col).unwrap() + 1;
                let row = row0 + u32::try_from(row).unwrap() + 1;
                target.cell_mut((col, row)).set_value_string(text);
            }
        }
    }
    workbook
        .sheet_by_name_mut(sheet)
        .expect("sheet should exist")
        .cell_mut(cell)
        .set_value(value);
    umya_spreadsheet::writer::xlsx::write(&workbook, path).unwrap();
}
