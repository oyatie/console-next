//! IMPORT-2 keys (decisions #25, backend-followups item 22). Append-only; see
//! `keys/mod.rs`. The workbook caps bound what one upload may make the server
//! inflate and parse (zip bomb, dense-grid bomb): platform switches, so no
//! tenant can loosen them. The other two are tenant policy.

macro_rules! import2 { ([$($acc:tt)*] $($rest:tt)*) => { roster! { [$($acc)*
    // Largest accepted upload (413 import_file_too_large above it).
    ImportUploadMaxMib => "import.upload.max_mib" = D::int(Mebibytes, Some(1), Some(64), 16, Higher).governed(Governance::PlatformOnly);
    // Most ZIP entries an .xlsx may hold (422 workbook_too_many_entries).
    ImportZipMaxEntries => "import.zip.max_entries" = D::int(Count, Some(16), Some(10_000), 1_000, Higher).governed(Governance::PlatformOnly);
    // Most bytes all entries may inflate to, counted while inflating (422 workbook_expands_too_far).
    ImportZipMaxExpandedMib => "import.zip.max_expanded_mib" = D::int(Mebibytes, Some(1), Some(1_024), 128, Higher).governed(Governance::PlatformOnly);
    // Highest inflated : compressed ratio of one entry (422 workbook_compression_ratio).
    ImportZipMaxRatio => "import.zip.max_ratio" = D::int(Count, Some(10), Some(1_000), 200, Higher).governed(Governance::PlatformOnly);
    // Largest rows × columns box of one sheet (422 sheet_grid_too_large).
    ImportSheetMaxGridCells => "import.sheet.max_grid_cells" = D::int(Count, Some(1_000), Some(50_000_000), 5_000_000, Higher).governed(Governance::PlatformOnly);
    // Most non-empty cells in one workbook (422 workbook_too_many_cells).
    ImportWorkbookMaxCells => "import.workbook.max_cells" = D::int(Count, Some(1_000), Some(10_000_000), 2_000_000, Higher).governed(Governance::PlatformOnly);
    // A row without 사번: numbered by the tenant rule (previewed) or left 「사번 미부여」 in the queue.
    ImportEmployeeNumberUnnumbered => "import.employee_number.unnumbered" = D::code(UNNUMBERED_MODES, "assign_by_rule", Higher);
    // Days a never-applied run keeps its sealed 주민등록번호 rows.
    ImportStagedIdentityTtlDays => "import.staged_identity.ttl_days" = D::int(Days, Some(1), Some(30), 7, Higher);
    ImportRollbackWindowDays => "import.rollback.window_days" = D::int(Days, Some(1), Some(30), 14, Higher);
] $($rest)* } }; }
