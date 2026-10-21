//! IMPORT-2: the likeliest header rows of a sheet the import could not
//! recognise — label-like cells only (short, not a number, a date, an RRN or
//! an e-mail), so the preview offers them to map without echoing values.

use serde::Serialize;

use super::cells::parse_import_date;
use super::grid::{GridRow, column_letter};
use super::rrn::is_rrn_value;

pub(super) const CANDIDATES: usize = 3;
const LABEL_MAX_CHARS: usize = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CandidateCell {
    pub column: String,
    pub label: String,
}

/// A row that may be the header, with its label-like cells only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HeaderCandidate {
    /// 1-based.
    pub row: u32,
    pub cells: Vec<CandidateCell>,
}

pub(super) fn label_like(text: &str) -> bool {
    let chars = text.chars().count();
    (1..=LABEL_MAX_CHARS).contains(&chars)
        && text.chars().filter(char::is_ascii_digit).count() < 4
        && !text.contains('@')
        && parse_import_date(text).is_none()
        && !is_rrn_value(text)
}

pub(super) fn candidates(rows: &[&GridRow]) -> Vec<HeaderCandidate> {
    let mut scored: Vec<(usize, HeaderCandidate)> = rows
        .iter()
        .map(|row| {
            let cells: Vec<CandidateCell> = row
                .cells
                .iter()
                .map(|(c, cell)| (*c, cell.text()))
                .filter(|(_, text)| label_like(text))
                .map(|(c, text)| CandidateCell {
                    column: column_letter(c),
                    label: text,
                })
                .collect();
            (
                cells.len(),
                HeaderCandidate {
                    row: row.index + 1,
                    cells,
                },
            )
        })
        .filter(|(n, _)| *n > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.row.cmp(&b.1.row)));
    scored
        .into_iter()
        .take(CANDIDATES)
        .map(|(_, c)| c)
        .collect()
}
