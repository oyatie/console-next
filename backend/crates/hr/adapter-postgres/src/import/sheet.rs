//! IMPORT-2 (decisions #25): one detected sheet → staged rows. Only mapped
//! sheets yield rows; a sheet that needs mapping yields its report and no
//! cell. Every target is read from the column the mapping names (never from
//! a same-named header elsewhere); restricted and 주민등록번호 cells are
//! dropped before the raw row exists, and an RRN column is sealed through
//! the vault into a staged identity (no vault: dropped, and the sheet says so).

use std::collections::{BTreeMap, BTreeSet};

use console_hr_domain::import::classification::{
    employee_import_column_classification, is_dropped_employee_import_header,
    normalize_header_label,
};
use console_hr_domain::import::detect::ColumnPlan;
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet, cell_ref, column_letter};
use console_hr_domain::import::normalize::employee_number;
use console_hr_domain::import::review::Note;
use console_hr_domain::import::roster_cells::{import_phone, is_summary_row};
use console_hr_domain::import::rrn::is_rrn_value;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn};
use console_hr_domain::import::sex::{sex_of_rrn, sex_of_text};
use console_hr_domain::import::workbook::header_notice;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::import::canonical::normalized_decimal_text;
use crate::import::parsed::{EmployeeCanonicalFields, ImportRowStatus, ParsedEmployeeImportRow};
use crate::import::persist::persistable_import_row;
use crate::import::types::EmployeeImportColumn;

/// A sealed 주민등록번호 waiting in `data_import_row_identities`.
#[derive(Debug, Clone)]
pub struct StagedIdentity {
    pub source_key: String,
    pub sealed: SealedRrn,
}

/// What one mapped sheet yields.
#[derive(Debug, Default)]
pub struct SheetRows {
    pub rows: Vec<ParsedEmployeeImportRow>,
    pub columns: Vec<EmployeeImportColumn>,
    pub identities: Vec<StagedIdentity>,
    pub notes: Vec<Note>,
    /// W12: `(source_key, E.164)` of the rows with a 휴대전화.
    pub phones: Vec<(String, String)>,
}

/// Where the cells of one row come from.
pub struct SheetContext<'a> {
    pub filename: &'a str,
    pub org: Uuid,
    pub vault: Option<&'a dyn RrnVault>,
}

pub fn cell_json(cell: Option<&Cell>) -> Value {
    match cell {
        None => Value::Null,
        Some(Cell::Text(text)) if text.trim().is_empty() => Value::Null,
        Some(Cell::Text(text)) => json!(text.trim()),
        Some(Cell::Int(v)) => json!(v),
        Some(Cell::Float(v)) if v.fract() == 0.0 && v.abs() < 9.0e15 => json!(*v as i64),
        Some(Cell::Float(v)) => json!(v),
        Some(Cell::Bool(v)) => json!(v),
    }
}

/// The raw-row key of each column: its normalised label, made unique.
fn keys(columns: &[ColumnPlan]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    columns
        .iter()
        .map(|c| {
            let label = normalize_header_label(&c.label);
            let key = if label.is_empty() || seen.contains(&label) {
                format!("{label}@{}", column_letter(c.column))
            } else {
                label
            };
            seen.insert(key.clone());
            key
        })
        .collect()
}

fn column(plan: &ColumnPlan, key: &str) -> EmployeeImportColumn {
    let classification = employee_import_column_classification(key, plan.target);
    EmployeeImportColumn {
        source_header: plan.label.trim().to_owned(),
        normalized_header: key.to_owned(),
        target: plan.target.map(ToOwned::to_owned),
        preview_allowed: classification == "canonical" || classification == "retained",
        classification: classification.to_owned(),
        notice: header_notice(key),
    }
}

struct Targets<'a>(&'a [ColumnPlan]);

impl Targets<'_> {
    fn column(&self, target: &str) -> Option<u32> {
        self.0
            .iter()
            .find(|c| c.target == Some(target))
            .map(|c| c.column)
    }

    fn text(&self, row: &GridRow, target: &str) -> Option<String> {
        let text = row.text(self.column(target)?);
        (!text.is_empty()).then_some(text)
    }
}

fn canonical(row: &GridRow, t: &Targets<'_>, rrn_sex: Option<&str>) -> EmployeeCanonicalFields {
    let text = |target: &str| t.text(row, target);
    let decimal = |target: &str| text(target).and_then(|v| normalized_decimal_text(&v));
    let exit_date = text("exit_date");
    EmployeeCanonicalFields {
        company_brn: text("company_brn"),
        employee_number: text("employee_number").and_then(|v| employee_number(&v)),
        org_unit: text("org_unit"),
        job: text("job"),
        position: text("position"),
        worksite_name: text("worksite_name"),
        worksite_address: text("worksite_address"),
        hire_date: text("hire_date"),
        employment_status: if exit_date.is_some() {
            "EXITED"
        } else {
            "ACTIVE"
        }
        .to_owned(),
        exit_date,
        birth_date: text("birth_date"),
        sex: text("sex")
            .as_deref()
            .and_then(sex_of_text)
            .or(rrn_sex)
            .map(str::to_owned),
        contract_end_date: text("contract_end_date"),
        probation_end_date: text("probation_end_date"),
        employment_type: text("employment_type"),
        leave_accrued: decimal("leave_accrued"),
        leave_used: decimal("leave_used"),
        leave_remaining: decimal("leave_remaining"),
        status: text("employment_status"),
        leave_start_date: text("leave_start_date"),
        leave_type: text("leave_type"),
        leave_return_date: text("leave_return_date"),
    }
}

/// The rows of a mapped sheet (`header_row` 0-based).
pub fn sheet_rows(
    ctx: &SheetContext<'_>,
    sheet: &GridSheet,
    header_row: u32,
    plans: &[ColumnPlan],
    source: &str,
) -> SheetRows {
    let keys = keys(plans);
    let columns: Vec<EmployeeImportColumn> =
        plans.iter().zip(&keys).map(|(p, k)| column(p, k)).collect();
    let restricted: BTreeSet<&str> = columns
        .iter()
        .filter(|c| {
            c.classification == "restricted"
                || is_dropped_employee_import_header(&c.normalized_header)
        })
        .map(|c| c.normalized_header.as_str())
        .collect();
    let targets = Targets(plans);
    let mut out = SheetRows {
        columns: columns.clone(),
        ..SheetRows::default()
    };
    let note = |reason: &'static str, row: Option<i32>, cell: Option<String>| Note {
        reason,
        blocking: false,
        sheet: sheet.name.clone(),
        row,
        cell,
    };
    let mut unavailable = false;
    for row in sheet
        .rows
        .iter()
        .filter(|r| r.index > header_row && !r.is_blank())
    {
        let source_row = i32::try_from(row.index + 1).unwrap_or(i32::MAX);
        let (raw_row, dropped) = persistable_import_row(
            &keys,
            |i| cell_json(plans.get(i).and_then(|p| row.get(p.column))),
            |key| restricted.contains(key),
        );
        // W12: a totals / footer row (`합계 | 300명`) is kept, never a person.
        let summary = is_summary_row(row, targets.column("name"), targets.column("hire_date"));
        if summary {
            out.notes
                .push(note("summary_row_skipped", Some(source_row), None));
        }
        let name = targets
            .text(row, "name")
            .filter(|v| !summary && !is_rrn_value(v));
        let source_key = format!(
            "filename:{}|sheet:{}|row:{source_row}",
            ctx.filename, sheet.name
        );
        if let (Some(_), Some(column)) = (&name, targets.column("phone"))
            && let Some(cell) = row.get(column)
            && !cell.text().is_empty()
        {
            match import_phone(&cell.text()) {
                Some(phone) => out.phones.push((source_key.clone(), phone)),
                None => {
                    let at = cell_ref(column, row.index);
                    out.notes
                        .push(note("phone_invalid", Some(source_row), Some(at)));
                }
            }
        }
        let cells: BTreeMap<&str, String> = plans
            .iter()
            .filter_map(|p| Some((p.target?, p.column)))
            .filter(|(_, c)| row.get(*c).is_some())
            .map(|(t, c)| (t, cell_ref(c, row.index)))
            .collect();
        let mut rrn_sex = None;
        if let Some(column) = targets.column("rrn")
            && let Some(cell) = row.get(column)
            && name.is_some()
        {
            let parsed = Rrn::parse(&cell.text());
            rrn_sex = parsed
                .as_ref()
                .ok()
                .and_then(|rrn| sex_of_rrn(rrn.digits()));
            match parsed {
                Err(_) => {
                    let at = cell_ref(column, row.index);
                    out.notes
                        .push(note("rrn_invalid", Some(source_row), Some(at)));
                }
                Ok(rrn) => match ctx.vault.map(|vault| vault.seal(ctx.org, &rrn)) {
                    Some(Ok(sealed)) => out.identities.push(StagedIdentity {
                        source_key: source_key.clone(),
                        sealed,
                    }),
                    // No vault (or it failed): the value is dropped, never stored.
                    _ if !unavailable => {
                        unavailable = true;
                        out.notes.push(note("rrn_unavailable", None, None));
                    }
                    _ => {}
                },
            }
        }
        // r3:hire-01: the 법인 text is the file's own 법인 column or nothing;
        // never the sheet's name. The apply derives the person's 법인 from
        // the 사업장 the plan places them at (`company`), else 법인 미정.
        let mapped_company = targets.text(row, "company");
        let company_source = if mapped_company.is_some() {
            "mapped_column"
        } else {
            "none"
        };
        out.rows.push(ParsedEmployeeImportRow {
            company: mapped_company.unwrap_or_default(),
            canonical: name.as_ref().map(|_| canonical(row, &targets, rrn_sex)),
            row_status: if name.is_some() { ImportRowStatus::Candidate } else { ImportRowStatus::Preserved },
            name,
            source_filename: ctx.filename.to_owned(),
            source_sheet: sheet.name.clone(),
            source_row,
            source_key,
            raw_row,
            source_metadata: json!({
                "filename": ctx.filename,
                "sheet": sheet.name,
                "row": source_row,
                "source_key_kind": "filename_sheet_row",
                "header_row": header_row + 1,
                "header_normalization": "trim_remove_whitespace_for_storage_schema_catalog_for_matching",
                "mapping_source": source,
                "company_source": company_source,
                "company_column": targets.0.iter().find(|c| c.target == Some("company")).map(|c| c.label.as_str()),
                "dropped_restricted_columns": dropped,
                "cells": cells,
            }),
        });
    }
    out
}

#[cfg(test)]
#[path = "sheet_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "sheet_w12_tests.rs"]
mod w12_tests;
