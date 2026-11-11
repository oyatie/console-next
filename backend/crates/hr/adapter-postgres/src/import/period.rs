// SPDX-License-Identifier: LicenseRef-Proprietary
//! Days and hours worked are facts of one pay period: what a run without a
//! period does with them.
use console_hr_domain::import::review::Note;
use serde_json::Value;

use crate::import::parsed::ParsedEmployeeImportWorkbook;

/// The targets that are facts of one pay period.
pub const PERIOD_TARGETS: [&str; 5] = [
    "work_days",
    "regular_hours",
    "overtime_hours",
    "night_hours",
    "holiday_hours",
];

/// A run without a pay period has no reader for a period's days and hours:
/// they are left out of every row, typed value and stored cell alike, and one
/// non-blocking note says so.
pub fn drop_period_values(parsed: &mut ParsedEmployeeImportWorkbook) {
    let headers: Vec<String> = parsed
        .columns
        .iter()
        .filter(|c| {
            c.target
                .as_deref()
                .is_some_and(|t| PERIOD_TARGETS.contains(&t))
        })
        .map(|c| c.normalized_header.clone())
        .collect();
    let mut sheet = None;
    for row in &mut parsed.rows {
        if let Some(cells) = row.raw_row.as_object_mut() {
            for header in &headers {
                cells.remove(header);
            }
        }
        let Some(typed) = &mut row.canonical else {
            continue;
        };
        for slot in [
            &mut typed.work_days,
            &mut typed.regular_hours,
            &mut typed.overtime_hours,
            &mut typed.night_hours,
            &mut typed.holiday_hours,
        ] {
            if slot.take().is_some() && sheet.is_none() {
                sheet = Some(row.source_sheet.clone());
            }
        }
    }
    // The preview says the same: these columns are not imported, not stored.
    for column in parsed.columns.iter_mut().filter(|c| {
        c.target
            .as_deref()
            .is_some_and(|t| PERIOD_TARGETS.contains(&t))
    }) {
        column.target = None;
        column.classification = "restricted".to_owned();
        column.preview_allowed = false;
    }
    for report in parsed.sheets.iter_mut().chain(&mut parsed.shown) {
        for column in report["columns"].as_array_mut().into_iter().flatten() {
            if column["target"]
                .as_str()
                .is_some_and(|t| PERIOD_TARGETS.contains(&t))
            {
                column["target"] = Value::Null;
            }
        }
    }
    if let Some(sheet) = sheet {
        parsed.notes.push(Note {
            reason: "work_period_missing",
            blocking: false,
            sheet,
            row: None,
            cell: None,
        });
    }
}
