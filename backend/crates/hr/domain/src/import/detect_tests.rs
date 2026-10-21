//! Header detection over synthetic layouts (values are made up).
#![allow(clippy::unwrap_used)]

use super::*;
use crate::import::detect_candidates::{CANDIDATES, label_like};
use crate::import::grid::Cell;
use crate::import::grid::column_letter;

pub(crate) fn sheet(name: &str, rows: &[&[&str]]) -> GridSheet {
    GridSheet {
        name: name.into(),
        rows: rows
            .iter()
            .enumerate()
            .map(|(i, cells)| GridRow {
                index: i as u32,
                cells: cells
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| !t.is_empty())
                    .map(|(c, t)| (c as u32, Cell::Text((*t).into())))
                    .collect(),
            })
            .filter(|r| !r.cells.is_empty())
            .collect(),
    }
}

fn mapped(d: SheetDetection) -> (u32, Vec<(String, Option<&'static str>)>) {
    match d {
        SheetDetection::Mapped {
            header_row,
            columns,
        } => (
            header_row,
            columns
                .into_iter()
                .map(|c| (column_letter(c.column), c.target))
                .collect(),
        ),
        other => panic!("not mapped: {other:?}"),
    }
}

fn none() -> BTreeMap<String, Option<String>> {
    BTreeMap::new()
}

#[test]
fn a_header_below_title_rows_and_in_english_is_found() {
    let s = sheet(
        "명부",
        &[
            &["2026 임직원 명부"],
            &[],
            &["", "사번", "성명", "부서"],
            &["", "1", "가", "총무"],
        ],
    );
    let (row, cols) = mapped(detect(&s, &none(), None).unwrap());
    assert_eq!(row, 2);
    assert_eq!(cols[0], ("B".into(), Some("employee_number")));
    assert_eq!(cols[1], ("C".into(), Some("name")));
    let en = sheet(
        "en",
        &[
            &["Dept", "Employee Name", "Hire Date"],
            &["x", "y", "2024-01-02"],
        ],
    );
    let (_, cols) = mapped(detect(&en, &none(), None).unwrap());
    assert_eq!(
        cols.iter().filter_map(|c| c.1).collect::<Vec<_>>(),
        ["org_unit", "name", "hire_date"]
    );
}

#[test]
fn a_non_roster_sheet_needs_mapping_and_offers_only_label_like_cells() {
    let s = sheet(
        "업무일지",
        &[
            &["일자", "작업내용", "담당", "비고"],
            &["2026-05-27", "점검", "010-1234-5678", "900101-1234567"],
            &["45000", "x-018@example.com", "확인", ""],
            &["45000", "a@b.example", "확인", ""],
        ],
    );
    let SheetDetection::NeedsMapping { candidates } = detect(&s, &none(), None).unwrap() else {
        panic!("expected NeedsMapping");
    };
    assert_eq!(candidates[0].row, 1);
    assert_eq!(candidates[0].cells.len(), 4);
    let all: Vec<&str> = candidates
        .iter()
        .flat_map(|c| c.cells.iter().map(|x| x.label.as_str()))
        .collect();
    for hidden in [
        "2026-05-27",
        "010-1234-5678",
        "900101-1234567",
        "45000",
        "x-018@example.com",
        "a@b.example",
    ] {
        assert!(!all.contains(&hidden), "{hidden}");
    }
}

#[test]
fn remembered_labels_win_over_the_catalog() {
    let s = sheet("s", &[&["직원", "소속", "사번"], &["가", "총무", "1"]]);
    assert!(matches!(
        detect(&s, &none(), None).unwrap(),
        SheetDetection::NeedsMapping { .. }
    ));
    let memory = BTreeMap::from([
        (memory_key("직원"), Some("name".into())),
        (memory_key("소속"), None),
    ]);
    let (_, cols) = mapped(detect(&s, &memory, None).unwrap());
    assert_eq!(
        cols,
        [
            ("A".into(), Some("name")),
            ("B".into(), None),
            ("C".into(), Some("employee_number"))
        ]
    );
}

#[test]
fn the_operators_mapping_is_checked_and_wins() {
    let s = sheet("s", &[&["제목"], &["가", "1", ""], &["나", "2", "x"]]);
    let request = |row: Option<u32>, cols: &[(&str, Option<&str>)]| SheetMappingRequest {
        header_row: row,
        columns: cols
            .iter()
            .map(|(c, t)| ((*c).into(), t.map(Into::into)))
            .collect(),
        skip: Some(false),
    };
    let ok = request(
        Some(1),
        &[
            ("A", Some("name")),
            ("b", Some("employee_number")),
            ("C", None),
        ],
    );
    let (row, cols) = mapped(detect(&s, &none(), Some(&ok)).unwrap());
    assert_eq!(row, 0);
    assert_eq!(
        cols.iter().filter_map(|c| c.1).collect::<Vec<_>>(),
        ["name", "employee_number"]
    );
    let err = |r: SheetMappingRequest| detect(&s, &none(), Some(&r)).unwrap_err().code();
    assert_eq!(
        err(request(Some(1), &[("A", Some("nickname"))])),
        "mapping_unknown_target"
    );
    assert_eq!(
        err(request(Some(1), &[("A1", Some("name"))])),
        "mapping_bad_column"
    );
    assert_eq!(
        err(request(
            Some(1),
            &[("A", Some("name")), ("B", Some("name"))]
        )),
        "mapping_duplicate_target"
    );
    assert_eq!(
        err(request(Some(1), &[("B", Some("employee_number"))])),
        "mapping_name_required"
    );
    assert_eq!(
        err(request(None, &[("A", Some("name"))])),
        "mapping_header_row_required"
    );
    assert_eq!(
        err(request(Some(99), &[("A", Some("name"))])),
        "mapping_header_row_out_of_range"
    );
    let skip = SheetMappingRequest {
        skip: Some(true),
        ..SheetMappingRequest::default()
    };
    assert_eq!(
        detect(&s, &none(), Some(&skip)).unwrap(),
        SheetDetection::Skipped
    );
    assert_eq!(
        detect(&sheet("e", &[]), &none(), None).unwrap(),
        SheetDetection::Empty
    );
}

#[test]
fn property_random_grids_never_panic_and_map_one_name_column() {
    let words = [
        "성명",
        "이름",
        "사번",
        "부서",
        "입사일",
        "비고",
        "",
        "x",
        "900101-1234567",
        "2024-01-01",
        "직급",
    ];
    let mut seed = 0x853C_49E6_748F_EA9Bu64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for _ in 0..2_000 {
        let rows: Vec<Vec<&str>> = (0..next() % 30)
            .map(|_| {
                (0..next() % 8)
                    .map(|_| words[(next() % words.len() as u64) as usize])
                    .collect()
            })
            .collect();
        let refs: Vec<&[&str]> = rows.iter().map(Vec::as_slice).collect();
        match detect(&sheet("p", &refs), &none(), None).unwrap() {
            SheetDetection::Mapped { columns, .. } => {
                assert_eq!(
                    columns.iter().filter(|c| c.target == Some("name")).count(),
                    1
                );
            }
            SheetDetection::NeedsMapping { candidates } => {
                assert!(candidates.len() <= CANDIDATES);
                assert!(
                    candidates
                        .iter()
                        .flat_map(|c| &c.cells)
                        .all(|c| label_like(&c.label))
                );
            }
            other => assert_eq!(other, SheetDetection::Empty),
        }
    }
}
