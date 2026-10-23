//! IMPORT-2 (decisions #25): a whole workbook of any layout → the staged
//! run. Every sheet is detected on its own (operator mapping, remembered
//! labels, catalog); mapped sheets give rows, the others give a report and a
//! blocking 「확인 필요」 item, never an error and never a guess.

use std::collections::BTreeMap;

use console_hr_domain::import::detect::{
    MappingSource, SheetDetection, WorkbookMappingRequest, detect, memory_key,
};
use console_hr_domain::import::grid::{GridSheet, column_letter};
use console_hr_domain::import::review::Note;
use console_hr_domain::import::roster_cells::sheet_memory_key;

use serde_json::{Value, json};

use crate::HrError;
use crate::import::header::reject_rrn_label;
use crate::import::parsed::ParsedEmployeeImportWorkbook;
use crate::import::sheet::{SheetContext, sheet_rows};

fn unprocessable(code: &'static str, message: String) -> HrError {
    HrError {
        errors: None,
        status: http::StatusCode::UNPROCESSABLE_ENTITY,
        code,
        message,
        refusals: None,
    }
}

/// The operator's `mapping` field of the upload (absent: detect everything).
///
/// # Errors
/// 422 `mapping_invalid` for JSON that is not a workbook mapping.
pub fn mapping_request(text: Option<&str>) -> Result<WorkbookMappingRequest, HrError> {
    match text.map(str::trim).filter(|t| !t.is_empty()) {
        None => Ok(WorkbookMappingRequest::default()),
        Some(text) => serde_json::from_str(text).map_err(|_| {
            unprocessable(
                "mapping_invalid",
                "the mapping is not a workbook mapping".into(),
            )
        }),
    }
}

/// The run's rows, columns, identities, notes and sheet reports.
///
/// # Errors
/// 422 for a sheet name carrying an RRN, a mapping that names no sheet of
/// the workbook, or a sheet mapping that cannot apply (`mapping_*`).
pub fn parse_workbook(
    ctx: &SheetContext<'_>,
    sheets: &[GridSheet],
    memory: &BTreeMap<String, Option<String>>,
    mapping: &WorkbookMappingRequest,
) -> Result<ParsedEmployeeImportWorkbook, HrError> {
    if let Some(name) = mapping
        .sheets
        .keys()
        .find(|name| !sheets.iter().any(|s| &s.name == *name))
    {
        return Err(unprocessable(
            "mapping_unknown_sheet",
            format!("the mapping names no sheet of the workbook: {name}"),
        ));
    }
    let mut parsed = ParsedEmployeeImportWorkbook::default();
    let mut columns = BTreeMap::new();
    for sheet in sheets {
        reject_rrn_label(
            &sheet.name,
            "workbook sheet names must not contain a resident registration number",
        )?;
        // W12: a sheet skipped once is skipped again (by name) until the
        // operator sends `skip: false` or maps it (header row or columns):
        // a remembered skip never hides a sheet someone is mapping. An
        // explicit choice, or an import that lifts a remembered skip, is
        // remembered.
        let operator = mapping.sheets.get(&sheet.name);
        let memo = sheet_memory_key(&sheet.name);
        let was_skipped = memory.get(&memo).and_then(Option::as_deref) == Some("skip");
        let mapped = operator.is_some_and(|m| m.header_row.is_some() || !m.columns.is_empty());
        let chosen = operator.and_then(|m| m.skip).or(mapped.then_some(false));
        match chosen {
            Some(true) => parsed.remembered.push((memo.clone(), Some("skip".into()))),
            Some(false) if was_skipped || operator.and_then(|m| m.skip).is_some() => {
                parsed
                    .remembered
                    .push((memo.clone(), Some("import".into())));
            }
            _ => {}
        }
        let remembered_skip = chosen.is_none() && was_skipped;
        let detection = if remembered_skip {
            SheetDetection::Skipped
        } else {
            detect(sheet, memory, operator).map_err(|error| {
                unprocessable(error.code(), format!("sheet {}: {error:?}", sheet.name))
            })?
        };
        let mut rows = 0;
        match &detection {
            SheetDetection::Mapped {
                header_row,
                columns: plans,
            } => {
                let source = if plans.iter().any(|c| c.source == MappingSource::Operator) {
                    "operator"
                } else if plans.iter().any(|c| c.source == MappingSource::Remembered) {
                    "remembered"
                } else {
                    "catalog"
                };
                let out = sheet_rows(ctx, sheet, *header_row, plans, source);
                rows = out.rows.len();
                for column in out.columns {
                    columns
                        .entry(column.normalized_header.clone())
                        .or_insert(column);
                }
                parsed.rows.extend(out.rows);
                parsed.identities.extend(out.identities);
                parsed.phones.extend(out.phones);
                parsed.notes.extend(out.notes);
                parsed.remembered.extend(
                    plans
                        .iter()
                        .filter(|c| {
                            c.source == MappingSource::Operator && !c.label.trim().is_empty()
                        })
                        .map(|c| (memory_key(&c.label), c.target.map(ToOwned::to_owned))),
                );
            }
            SheetDetection::NeedsMapping { .. } => parsed.notes.push(Note {
                reason: "sheet_needs_mapping",
                blocking: true,
                sheet: sheet.name.clone(),
                row: None,
                cell: None,
            }),
            SheetDetection::Empty | SheetDetection::Skipped => {}
        }
        let mut stored = sheet_report(sheet, &detection, rows, false);
        let mut shown = sheet_report(sheet, &detection, rows, true);
        if remembered_skip {
            stored["source"] = "remembered".into();
            shown["source"] = "remembered".into();
        }
        parsed.sheets.push(stored);
        parsed.shown.push(shown);
    }
    parsed.columns = columns.into_values().collect();
    parsed
        .remembered
        .retain(|(key, _)| (1..=100).contains(&key.chars().count()));
    Ok(parsed)
}

/// The report of one sheet. `with_candidates`: the response only — the
/// header candidates of an unmapped sheet are never stored with the run.
pub fn sheet_report(
    sheet: &GridSheet,
    detection: &SheetDetection,
    rows: usize,
    with_candidates: bool,
) -> Value {
    let status = match detection {
        SheetDetection::Empty => "empty",
        SheetDetection::Skipped => "skipped",
        SheetDetection::Mapped { .. } => "mapped",
        SheetDetection::NeedsMapping { .. } => "needs_mapping",
    };
    let mut report = json!({ "name": sheet.name, "status": status, "rows": rows });
    match detection {
        SheetDetection::Mapped {
            header_row,
            columns,
        } => {
            report["header_row"] = json!(header_row + 1);
            report["columns"] = json!(
                columns
                    .iter()
                    .map(|c| json!({
                        "column": column_letter(c.column),
                        "label": c.label,
                        "target": c.target,
                        "source": c.source,
                    }))
                    .collect::<Vec<_>>()
            );
        }
        SheetDetection::NeedsMapping { candidates } if with_candidates => {
            report["header_candidates"] = json!(candidates);
        }
        _ => {}
    }
    report
}
