// SPDX-License-Identifier: LicenseRef-Proprietary
//! Explicit operator choices for fixtures testing stages after column confirmation.
use console_hr_domain::import::detect::{
    SheetDetection, SheetMappingRequest, WorkbookMappingRequest, detect,
};
use console_hr_domain::import::grid::{GridSheet, column_letter};
use console_hr_domain::import::roster_cells::sheet_memory_key;
use std::collections::BTreeMap;

pub fn confirmed_mapping(
    sheets: &[GridSheet],
    memory: &BTreeMap<String, Option<String>>,
    mapping: &WorkbookMappingRequest,
) -> WorkbookMappingRequest {
    let mut confirmed = mapping.clone();
    for sheet in sheets {
        if !mapping.sheets.contains_key(&sheet.name)
            && memory
                .get(&sheet_memory_key(&sheet.name))
                .and_then(Option::as_deref)
                == Some("skip")
        {
            continue;
        }
        if let Ok(SheetDetection::Mapped {
            header_row,
            columns,
        }) = detect(sheet, memory, mapping.sheets.get(&sheet.name))
        {
            confirmed.sheets.insert(
                sheet.name.clone(),
                SheetMappingRequest {
                    header_row: Some(header_row + 1),
                    columns: columns
                        .iter()
                        .filter(|c| {
                            c.target.is_some()
                                || mapping.sheets.get(&sheet.name).is_some_and(|m| {
                                    m.columns.contains_key(&column_letter(c.column))
                                })
                        })
                        .map(|c| (column_letter(c.column), c.target.map(str::to_owned)))
                        .collect(),
                    skip: mapping.sheets.get(&sheet.name).and_then(|m| m.skip),
                },
            );
        }
    }
    confirmed
}
