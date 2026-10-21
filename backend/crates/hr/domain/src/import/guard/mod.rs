//! IMPORT-2 item 0: what one uploaded workbook may cost before and while it is
//! parsed — the ZIP container (entries, real inflated bytes, ratio) and the
//! sheets (rows × columns box, non-empty cells). The caps are registry keys
//! (`import.*`, platform switches); the shell resolves them and passes them in.

pub mod inflate;
pub mod zip;

/// The refusal codes (422; 413 for the upload size, which the shell checks
/// while streaming).
pub mod codes {
    pub const FILE_TOO_LARGE: &str = "import_file_too_large";
    pub const TOO_MANY_ENTRIES: &str = "workbook_too_many_entries";
    pub const EXPANDS_TOO_FAR: &str = "workbook_expands_too_far";
    pub const COMPRESSION_RATIO: &str = "workbook_compression_ratio";
    pub const GRID_TOO_LARGE: &str = "sheet_grid_too_large";
    pub const TOO_MANY_CELLS: &str = "workbook_too_many_cells";
    /// Not a plain stored/deflate ZIP (or a damaged one).
    pub const CORRUPT: &str = "workbook_corrupt";
}

/// The caps one upload is held to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkbookCaps {
    pub max_upload_bytes: u64,
    pub max_entries: usize,
    pub max_expanded_bytes: u64,
    pub max_ratio: u64,
    pub max_grid_cells: u64,
    pub max_cells: u64,
}

/// Counts cells while a sheet streams; refuses as soon as a cap is passed.
#[derive(Debug)]
pub struct CellBudget {
    caps: WorkbookCaps,
    cells: u64,
}

impl CellBudget {
    #[must_use]
    pub const fn new(caps: WorkbookCaps) -> Self {
        Self { caps, cells: 0 }
    }

    /// A sheet's rows × columns box (its declared dimension or the box its
    /// cells reached so far).
    ///
    /// # Errors
    /// [`codes::GRID_TOO_LARGE`] above `max_grid_cells`.
    pub fn check_box(&self, rows: u64, columns: u64) -> Result<(), &'static str> {
        if rows.saturating_mul(columns) > self.caps.max_grid_cells {
            Err(codes::GRID_TOO_LARGE)
        } else {
            Ok(())
        }
    }

    /// One more non-empty cell.
    ///
    /// # Errors
    /// [`codes::TOO_MANY_CELLS`] above `max_cells` for the workbook.
    pub fn count(&mut self) -> Result<(), &'static str> {
        self.cells += 1;
        if self.cells > self.caps.max_cells {
            Err(codes::TOO_MANY_CELLS)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
#[path = "guard_tests.rs"]
mod tests;
