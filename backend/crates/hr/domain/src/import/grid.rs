//! A worksheet as the import reads it: only the non-empty cells, typed, in
//! row then column order. The shell fills it from the workbook reader under
//! the [`super::guard`] caps; everything after (header detection, mapping,
//! rows) works on this, so it is testable without a workbook.

/// One non-empty cell. A date cell arrives as `YYYY-MM-DD` text.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Text(String),
    Int(i64),
    Float(f64),
    Bool(bool),
}

impl Cell {
    /// The cell as the import compares it: trimmed text; a whole float
    /// without `.0` (a 사번 or a phone number typed as a number).
    #[must_use]
    pub fn text(&self) -> String {
        match self {
            Self::Text(text) => text.trim().to_owned(),
            Self::Int(value) => value.to_string(),
            Self::Float(value) if value.fract() == 0.0 && value.abs() < 9.0e15 => {
                format!("{value:.0}")
            }
            Self::Float(value) => value.to_string(),
            Self::Bool(value) => value.to_string(),
        }
    }
}

/// One row: its 0-based index and its cells as `(0-based column, cell)`,
/// columns ascending.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GridRow {
    pub index: u32,
    pub cells: Vec<(u32, Cell)>,
}

impl GridRow {
    #[must_use]
    pub fn get(&self, column: u32) -> Option<&Cell> {
        self.cells
            .binary_search_by_key(&column, |(c, _)| *c)
            .ok()
            .and_then(|at| self.cells.get(at))
            .map(|(_, cell)| cell)
    }

    /// The cell's text, `""` when empty.
    #[must_use]
    pub fn text(&self, column: u32) -> String {
        self.get(column).map(Cell::text).unwrap_or_default()
    }

    #[must_use]
    pub fn is_blank(&self) -> bool {
        self.cells.iter().all(|(_, cell)| cell.text().is_empty())
    }
}

/// A sheet: its name and its non-empty rows, ascending.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GridSheet {
    pub name: String,
    pub rows: Vec<GridRow>,
}

/// `0` → `A`, `25` → `Z`, `26` → `AA`.
#[must_use]
pub fn column_letter(column: u32) -> String {
    let mut n = u64::from(column) + 1;
    let mut out = Vec::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        out.push(char::from(b'A' + u8::try_from(rem).unwrap_or(0)));
        n = (n - 1) / 26;
    }
    out.iter().rev().collect()
}

/// `A` → `0`; `None` for anything but 1–3 ASCII letters.
#[must_use]
pub fn parse_column_letter(text: &str) -> Option<u32> {
    if text.is_empty() || text.len() > 3 {
        return None;
    }
    text.bytes()
        .try_fold(0u32, |n, b| {
            b.is_ascii_alphabetic()
                .then(|| n * 26 + u32::from(b.to_ascii_uppercase() - b'A') + 1)
        })
        .map(|n| n - 1)
}

/// `B14` for 0-based column 1, 0-based row 13.
#[must_use]
pub fn cell_ref(column: u32, row: u32) -> String {
    format!("{}{}", column_letter(column), u64::from(row) + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_letters_round_trip() {
        for (n, s) in [
            (0, "A"),
            (25, "Z"),
            (26, "AA"),
            (701, "ZZ"),
            (16_383, "XFD"),
        ] {
            assert_eq!(column_letter(n), s);
            assert_eq!(parse_column_letter(s), Some(n));
        }
        assert_eq!(parse_column_letter("b"), Some(1));
        for bad in ["", "1", "A1", "ABCD"] {
            assert_eq!(parse_column_letter(bad), None);
        }
        assert_eq!(cell_ref(1, 13), "B14");
    }

    #[test]
    fn property_every_column_round_trips() {
        for n in 0..18_278 {
            assert_eq!(parse_column_letter(&column_letter(n)), Some(n));
        }
    }

    #[test]
    fn a_whole_float_reads_without_its_fraction() {
        assert_eq!(Cell::Float(1234.0).text(), "1234");
        assert_eq!(Cell::Float(12.5).text(), "12.5");
        assert_eq!(Cell::Text("  a ".into()).text(), "a");
        let row = GridRow {
            index: 3,
            cells: vec![(1, Cell::Int(7)), (4, Cell::Text(" ".into()))],
        };
        assert_eq!(row.text(1), "7");
        assert_eq!(row.text(2), "");
        assert!(!row.is_blank());
        assert!(
            GridRow {
                index: 0,
                cells: vec![(0, Cell::Text(" ".into()))]
            }
            .is_blank()
        );
    }
}
