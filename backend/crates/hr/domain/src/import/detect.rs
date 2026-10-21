//! IMPORT-2 (decisions #25): which row of a sheet is its header and which
//! column is which target, for any layout. In order: the operator's mapping
//! for the sheet, then the tenant's remembered header labels, then the
//! catalog aliases. A sheet with content but no row naming a 성명 column is
//! not guessed at: it comes back `NeedsMapping` with its likeliest header
//! rows, and its cells are not kept.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::classification::{import_header_match_key, normalize_header_label};
use super::detect_candidates::candidates;
pub use super::detect_candidates::{CandidateCell, HeaderCandidate};
use super::fields::EMPLOYEE_IMPORT_FIELD_DEFINITIONS;
use super::grid::{GridRow, GridSheet, parse_column_letter};
use super::rrn::is_rrn_value;

/// Rows searched for a header (non-empty rows from the top).
pub const HEADER_SCAN_ROWS: usize = 25;

/// The operator's mapping of one sheet (`mapping` field of the preview upload).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SheetMappingRequest {
    /// 1-based row of the header; `None`: detect it.
    #[serde(default)]
    pub header_row: Option<u32>,
    /// Column letter → target, or `null`: not imported.
    #[serde(default)]
    pub columns: BTreeMap<String, Option<String>>,
    /// The sheet is not imported at all (`true`), or is after all (`false`,
    /// overriding a remembered skip, W12); `None`: as remembered, else imported.
    #[serde(default)]
    pub skip: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkbookMappingRequest {
    #[serde(default)]
    pub sheets: BTreeMap<String, SheetMappingRequest>,
}

/// Where a column's target came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MappingSource {
    Catalog,
    Remembered,
    Operator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColumnPlan {
    pub column: u32,
    /// The header label as written (`""` for a column without one).
    pub label: String,
    pub target: Option<&'static str>,
    pub source: MappingSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SheetDetection {
    Empty,
    Skipped,
    Mapped {
        /// 0-based row index of the header.
        header_row: u32,
        columns: Vec<ColumnPlan>,
    },
    NeedsMapping {
        candidates: Vec<HeaderCandidate>,
    },
}

/// A mapping the operator sent that cannot apply (422, code per variant).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MappingError {
    UnknownTarget(String),
    BadColumn(String),
    HeaderRowOutOfRange,
    /// Columns were mapped without saying which row is the header.
    HeaderRowRequired,
    NameRequired,
    DuplicateTarget(&'static str),
}

impl MappingError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::UnknownTarget(_) => "mapping_unknown_target",
            Self::BadColumn(_) => "mapping_bad_column",
            Self::HeaderRowOutOfRange => "mapping_header_row_out_of_range",
            Self::HeaderRowRequired => "mapping_header_row_required",
            Self::NameRequired => "mapping_name_required",
            Self::DuplicateTarget(_) => "mapping_duplicate_target",
        }
    }
}

/// A target by its wire name (only catalog targets exist).
#[must_use]
pub fn known_target(name: &str) -> Option<&'static str> {
    EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .find(|field| field.target == name)
        .map(|field| field.target)
}

/// The memory key of a header label.
#[must_use]
pub fn memory_key(label: &str) -> String {
    import_header_match_key(label)
}

/// A header label's target: remembered first, then the catalog.
fn target_of(
    label: &str,
    memory: &BTreeMap<String, Option<String>>,
) -> (Option<&'static str>, MappingSource) {
    if label.is_empty() {
        return (None, MappingSource::Catalog);
    }
    if let Some(remembered) = memory.get(&memory_key(label)) {
        return (
            remembered.as_deref().and_then(known_target),
            MappingSource::Remembered,
        );
    }
    let key = import_header_match_key(label);
    let target = EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .find(|field| {
            field
                .aliases
                .iter()
                .any(|a| import_header_match_key(a) == key)
        })
        .map(|field| field.target);
    (target, MappingSource::Catalog)
}

/// A header cell's label: an RRN-shaped "header" (a form-layout sheet) is no label.
fn label(row: &GridRow, column: u32) -> String {
    let text = row.text(column);
    if is_rrn_value(&text) {
        String::new()
    } else {
        text
    }
}

fn plan_row(
    row: &GridRow,
    memory: &BTreeMap<String, Option<String>>,
    operator: &BTreeMap<u32, Option<&'static str>>,
) -> Vec<ColumnPlan> {
    let mut columns: Vec<u32> = row.cells.iter().map(|(c, _)| *c).collect();
    columns.extend(operator.keys().copied());
    columns.sort_unstable();
    columns.dedup();
    let mut taken: Vec<&'static str> = Vec::new();
    columns
        .into_iter()
        .filter_map(|column| {
            let label = label(row, column);
            let (target, source) = match operator.get(&column) {
                Some(target) => (*target, MappingSource::Operator),
                None => target_of(&normalize_header_label(&label), memory),
            };
            if label.is_empty() && target.is_none() {
                return None;
            }
            // A second column of one target keeps its cells, mapped to nothing.
            let target = target.filter(|t| !taken.contains(t));
            taken.extend(target);
            Some(ColumnPlan {
                column,
                label,
                target,
                source,
            })
        })
        .collect()
}

fn operator_columns(
    request: &SheetMappingRequest,
) -> Result<BTreeMap<u32, Option<&'static str>>, MappingError> {
    let mut out = BTreeMap::new();
    for (letter, target) in &request.columns {
        let column =
            parse_column_letter(letter).ok_or_else(|| MappingError::BadColumn(letter.clone()))?;
        let target = match target {
            Some(name) => {
                Some(known_target(name).ok_or_else(|| MappingError::UnknownTarget(name.clone()))?)
            }
            None => None,
        };
        if let Some(t) = target
            && out.values().any(|v| *v == Some(t))
        {
            return Err(MappingError::DuplicateTarget(t));
        }
        out.insert(column, target);
    }
    Ok(out)
}

/// The sheet's header and column targets.
///
/// # Errors
/// A [`MappingError`] when the operator's mapping for the sheet cannot apply.
pub fn detect(
    sheet: &GridSheet,
    memory: &BTreeMap<String, Option<String>>,
    operator: Option<&SheetMappingRequest>,
) -> Result<SheetDetection, MappingError> {
    if operator.is_some_and(|m| m.skip == Some(true)) {
        return Ok(SheetDetection::Skipped);
    }
    let rows: Vec<&GridRow> = sheet.rows.iter().filter(|r| !r.is_blank()).collect();
    if rows.is_empty() {
        return Ok(SheetDetection::Empty);
    }
    let fixed = operator
        .map(operator_columns)
        .transpose()?
        .unwrap_or_default();
    if !fixed.is_empty() && operator.is_some_and(|m| m.header_row.is_none()) {
        return Err(MappingError::HeaderRowRequired);
    }
    let has_name = |plan: &[ColumnPlan]| plan.iter().any(|c| c.target == Some("name"));
    if let Some(header) = operator.and_then(|m| m.header_row) {
        let index = header
            .checked_sub(1)
            .ok_or(MappingError::HeaderRowOutOfRange)?;
        let empty = GridRow {
            index,
            cells: Vec::new(),
        };
        let row = sheet
            .rows
            .iter()
            .find(|r| r.index == index)
            .unwrap_or(&empty);
        if sheet.rows.last().is_none_or(|last| index > last.index) {
            return Err(MappingError::HeaderRowOutOfRange);
        }
        let columns = plan_row(row, memory, &fixed);
        return if has_name(&columns) {
            Ok(SheetDetection::Mapped {
                header_row: index,
                columns,
            })
        } else {
            Err(MappingError::NameRequired)
        };
    }
    let scan: Vec<&GridRow> = rows.iter().take(HEADER_SCAN_ROWS).copied().collect();
    let best = scan
        .iter()
        .map(|row| (row.index, plan_row(row, memory, &fixed)))
        .filter(|(_, plan)| has_name(plan))
        .max_by(|a, b| {
            let score = |p: &[ColumnPlan]| p.iter().filter(|c| c.target.is_some()).count();
            score(&a.1).cmp(&score(&b.1)).then(b.0.cmp(&a.0))
        });
    Ok(match best {
        Some((header_row, columns)) => SheetDetection::Mapped {
            header_row,
            columns,
        },
        None if operator.is_some() => return Err(MappingError::NameRequired),
        None => SheetDetection::NeedsMapping {
            candidates: candidates(&scan),
        },
    })
}

#[cfg(test)]
#[path = "detect_tests.rs"]
mod tests;
