//! W12 at the parse: totals rows, the phone column, remembered sheet skips.

use std::collections::BTreeMap;

use console_hr_domain::import::detect::{SheetMappingRequest, WorkbookMappingRequest};
use console_hr_domain::import::grid::{Cell, GridSheet};
use uuid::Uuid;

use super::SheetContext;
use super::tests::grid;
use crate::import::parsed::{ImportRowStatus, ParsedEmployeeImportWorkbook};
use crate::import::workbook::parse_workbook;

fn roster(rows: &[[&str; 4]]) -> GridSheet {
    let mut cells = Vec::new();
    for (r, row) in [["사번", "성명", "입사일", "연락처"]]
        .iter()
        .chain(rows)
        .enumerate()
    {
        for (c, text) in row.iter().enumerate().filter(|(_, t)| !t.is_empty()) {
            let cell = match text.parse::<f64>() {
                Ok(n) if !text.starts_with('0') => Cell::Float(n),
                _ => Cell::Text((*text).into()),
            };
            cells.push((r as u32, c as u32, cell));
        }
    }
    grid("명부", &cells)
}

fn parse(
    sheets: &[GridSheet],
    memory: &BTreeMap<String, Option<String>>,
    mapping: &WorkbookMappingRequest,
) -> Result<ParsedEmployeeImportWorkbook, String> {
    let ctx = SheetContext {
        filename: "roster.xlsx",
        org: Uuid::nil(),
        vault: None,
    };
    parse_workbook(&ctx, sheets, memory, mapping).map_err(|e| e.message)
}

/// regression (W12): the footer 「합계 | 300명」 was a candidate person.
#[test]
fn regression_a_footer_row_is_kept_but_never_a_candidate() -> Result<(), String> {
    let sheet = roster(&[["E-1", "김일", "2024-03-04", ""], ["합계", "1명", "", ""]]);
    let parsed = parse(
        &[sheet],
        &BTreeMap::new(),
        &WorkbookMappingRequest::default(),
    )?;
    let statuses: Vec<_> = parsed.rows.iter().map(|r| r.row_status).collect();
    assert_eq!(
        statuses,
        [ImportRowStatus::Candidate, ImportRowStatus::Preserved]
    );
    assert!(parsed.rows[1].name.is_none());
    let notes: Vec<_> = parsed
        .notes
        .iter()
        .map(|n| (n.reason, n.blocking, n.row))
        .collect();
    assert_eq!(notes, [("summary_row_skipped", false, Some(3))]);
    Ok(())
}

/// regression (W12): 연락처 was 저장하지 않음; now it is read as E.164 and
/// still never kept in the raw row or shown in a preview.
#[test]
fn regression_the_phone_column_is_read_but_never_kept_raw() -> Result<(), String> {
    let sheet = roster(&[
        ["E-1", "김일", "2024-03-04", "1012345678"],
        ["E-2", "김이", "2024-03-04", "없음"],
    ]);
    let parsed = parse(
        &[sheet],
        &BTreeMap::new(),
        &WorkbookMappingRequest::default(),
    )?;
    let key = &parsed.rows[0].source_key;
    assert_eq!(parsed.phones, [(key.clone(), "+821012345678".to_owned())]);
    for row in &parsed.rows {
        let canonical = serde_json::to_string(&row.canonical).map_err(|e| e.to_string())?;
        assert!(
            !canonical.contains("1012345678"),
            "never in the stored row: {canonical}"
        );
    }
    let column = parsed
        .columns
        .iter()
        .find(|c| c.target.as_deref() == Some("phone"));
    let column = column.ok_or("연락처 maps to phone")?;
    assert_eq!(column.classification, "restricted");
    assert!(!column.preview_allowed);
    for row in &parsed.rows {
        let raw = row.raw_row.to_string();
        assert!(
            !raw.contains("1012345678") && !raw.contains("없음"),
            "{raw}"
        );
    }
    let notes: Vec<_> = parsed
        .notes
        .iter()
        .map(|n| (n.reason, n.cell.clone()))
        .collect();
    assert_eq!(notes, [("phone_invalid", Some("D3".into()))]);
    Ok(())
}

/// regression (W12): a skipped notes sheet had to be skipped again on every upload.
#[test]
fn regression_a_skipped_sheet_stays_skipped_until_imported_again() -> Result<(), String> {
    let notes = grid(
        "메모",
        &[
            (0, 0, Cell::Text("성명".into())),
            (1, 0, Cell::Text("김메모".into())),
        ],
    );
    let skip = |skip: Option<bool>| WorkbookMappingRequest {
        sheets: BTreeMap::from([(
            "메모".to_owned(),
            SheetMappingRequest {
                skip,
                ..SheetMappingRequest::default()
            },
        )]),
    };
    let first = parse(
        std::slice::from_ref(&notes),
        &BTreeMap::new(),
        &skip(Some(true)),
    )?;
    assert!(first.rows.is_empty());
    assert_eq!(
        first.remembered,
        [("sheet:메모".to_owned(), Some("skip".to_owned()))]
    );

    let memory: BTreeMap<_, _> = first.remembered.into_iter().collect();
    let again = parse(
        std::slice::from_ref(&notes),
        &memory,
        &WorkbookMappingRequest::default(),
    )?;
    assert!(again.rows.is_empty());
    assert_eq!(
        (&again.sheets[0]["status"], &again.sheets[0]["source"]),
        (&"skipped".into(), &"remembered".into())
    );

    // Mapping the sheet (no skip field, as the import screen sends it) is
    // an explicit choice to import it: a remembered skip never hides it.
    let mapped = WorkbookMappingRequest {
        sheets: BTreeMap::from([(
            "메모".to_owned(),
            SheetMappingRequest {
                header_row: Some(1),
                columns: BTreeMap::from([("A".to_owned(), Some("name".to_owned()))]),
                skip: None,
            },
        )]),
    };
    let remapped = parse(std::slice::from_ref(&notes), &memory, &mapped)?;
    assert_eq!(remapped.rows.len(), 1);
    assert_eq!(
        remapped.remembered.first(),
        Some(&("sheet:메모".to_owned(), Some("import".to_owned()))),
        "mapping lifts the remembered skip"
    );
    let imported = parse(std::slice::from_ref(&notes), &memory, &skip(Some(false)))?;
    assert_eq!(imported.rows.len(), 1);
    assert_eq!(
        imported.remembered[0],
        ("sheet:메모".to_owned(), Some("import".to_owned()))
    );
    Ok(())
}

/// regression (r3:hire-01): a sheet with no 법인 column gave every person
/// the sheet's name (「퇴직자 명단」) as their 법인.
#[test]
fn regression_a_sheet_name_never_becomes_a_company() -> Result<(), String> {
    let parsed = parse(
        &[roster(&[["E-1", "김일", "2024-03-04", ""]])],
        &BTreeMap::new(),
        &WorkbookMappingRequest::default(),
    )?;
    let row = &parsed.rows[0];
    assert_eq!(row.company, "", "the sheet is 「명부」");
    assert_eq!(row.source_metadata["company_source"], "none");
    Ok(())
}
