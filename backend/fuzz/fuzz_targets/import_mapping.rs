//! The import page's mapping request (`WorkbookMappingRequest`, the body of
//! the preview/apply routes) applied to a sheet. Input:
//! `<mapping JSON>\0<sheet>` where the sheet is lines of tab-separated cells.
//! Invariants: never panic; an operator mapping never yields two columns with
//! one target.
#![no_main]

use std::collections::BTreeMap;

use console_hr_domain::import::detect::{SheetDetection, WorkbookMappingRequest, detect};
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet};
use libfuzzer_sys::fuzz_target;

fn sheet(text: &str) -> GridSheet {
    let rows = text
        .lines()
        .take(200)
        .enumerate()
        .map(|(i, line)| GridRow {
            index: u32::try_from(i).unwrap_or(u32::MAX),
            cells: line
                .split('\t')
                .take(64)
                .enumerate()
                .filter(|(_, c)| !c.is_empty())
                .map(|(j, c)| (u32::try_from(j).unwrap_or(0), Cell::Text(c.to_owned())))
                .collect(),
        })
        .collect();
    GridSheet {
        name: "Sheet1".to_owned(),
        rows,
    }
}

fuzz_target!(|bytes: &[u8]| {
    let mut parts = bytes.splitn(2, |b| *b == 0);
    let (Some(mapping), Some(grid)) = (parts.next(), parts.next()) else {
        return;
    };
    let Ok(grid) = std::str::from_utf8(grid) else {
        return;
    };
    let request = serde_json::from_slice::<WorkbookMappingRequest>(mapping).unwrap_or_default();
    let sheet = sheet(grid);
    let memory: BTreeMap<String, Option<String>> = BTreeMap::new();
    let _ = detect(&sheet, &memory, None);
    for operator in request.sheets.values() {
        if let Ok(SheetDetection::Mapped { columns, .. }) = detect(&sheet, &memory, Some(operator))
        {
            let mut seen = std::collections::BTreeSet::new();
            for target in columns.iter().filter_map(|c| c.target) {
                assert!(seen.insert(target), "two columns map to {target}");
            }
        }
    }
});
