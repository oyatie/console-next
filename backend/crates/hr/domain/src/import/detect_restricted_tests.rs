// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;

use crate::import::detect::{SheetDetection, SheetMappingRequest, detect, memory_key};
use crate::import::grid::{Cell, GridRow, GridSheet, column_letter};

fn sheet(name: &str, rows: &[&[&str]]) -> GridSheet {
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
fn restricted_headers_cannot_remap_and_poisoned_memory_is_ignored() {
    use crate::import::classification::employee_import_field_for_target;
    let name = employee_import_field_for_target("name").unwrap().aliases[0];
    let account = "account_no";
    let salary = "salary";
    let mobile = employee_import_field_for_target("phone").unwrap().aliases[0];
    let rrn = employee_import_field_for_target("rrn").unwrap().aliases[0];
    let birth = employee_import_field_for_target("birth_date")
        .unwrap()
        .aliases[0];
    let s = sheet(
        "s",
        &[
            &[name, account, salary, mobile, rrn, birth],
            &[
                "A",
                "123-456",
                "5000000",
                "010-1234-5678",
                "900101-1234567",
                "1990-01-01",
            ],
        ],
    );
    let req = |col: &str, target: Option<&str>| SheetMappingRequest {
        header_row: Some(1),
        columns: BTreeMap::from([(col.into(), target.map(Into::into))]),
        skip: Some(false),
    };
    for (col, target) in [
        ("B", "position"),
        ("C", "job"),
        ("D", "worksite_name"),
        ("E", "employee_number"),
    ] {
        let err = detect(&s, &none(), Some(&req(col, Some(target)))).unwrap_err();
        assert_eq!(err.code(), "mapping_restricted_column");
        let dbg = format!("{err:?}");
        assert!(!dbg.contains("123-456") && !dbg.contains("5000000"));
    }
    assert!(detect(&s, &none(), Some(&req("B", None))).is_ok());
    assert!(detect(&s, &none(), Some(&req("D", Some("phone")))).is_ok());
    assert!(detect(&s, &none(), Some(&req("E", Some("rrn")))).is_ok());
    assert!(detect(&s, &none(), Some(&req("F", Some("birth_date")))).is_ok());

    let poisoned = BTreeMap::from([
        (memory_key(account), Some("position".into())),
        (memory_key(mobile), Some("worksite_name".into())),
    ]);
    let (_, cols) = mapped(detect(&s, &poisoned, None).unwrap());
    assert_eq!(cols[1], ("B".into(), None));
    assert_eq!(cols[3], ("D".into(), Some("phone")));
}

#[test]
fn punctuation_split_restricted_headers_reject_remap_while_worksite_address_succeeds() {
    use crate::import::classification::employee_import_field_for_target;
    let ko = |cps: &[u32]| -> String {
        cps.iter()
            .map(|&c| char::from_u32(c).unwrap())
            .collect::<String>()
    };
    let name = employee_import_field_for_target("name").unwrap().aliases[0];
    let worksite_addr = employee_import_field_for_target("worksite_address")
        .unwrap()
        .aliases[1];
    assert_eq!(worksite_addr, ko(&[0xADFC, 0xBB34, 0xC9C0, 0xC8FC, 0xC18C]));

    let restricted_cases = [
        (ko(&[0xAC1C, 0xC778, 0x5F, 0xC8FC, 0xC18C]), "worksite_name"),
        (ko(&[0xAC70, 0xC8FC, 0x5F, 0xC8FC, 0xC18C]), "worksite_name"),
        (ko(&[0xAC1C, 0xC778, 0x2D, 0xC8FC, 0xC18C]), "position"),
        (ko(&[0x5B, 0xC8FC, 0xC18C, 0x5D]), "worksite_name"),
        (
            ko(&[0xC8FC, 0xC18C, 0x28, 0xAC1C, 0xC778, 0x29]),
            "worksite_name",
        ),
        (
            ko(&[0xD578, 0xB4DC, 0x5F, 0xD3F0, 0x28, 0xBE44, 0xC0C1, 0x29]),
            "position",
        ),
        (
            ko(&[0xC5F0, 0xB77D, 0x5F, 0xCC98, 0x28, 0xAC1C, 0xC778, 0x29]),
            "job",
        ),
    ];

    for (header, target) in restricted_cases {
        let s = sheet("s", &[&[name, &header], &["A", "SECRET_PII_CELL"]]);
        let req = SheetMappingRequest {
            header_row: Some(1),
            columns: BTreeMap::from([("B".into(), Some(target.into()))]),
            skip: Some(false),
        };
        let err = detect(&s, &none(), Some(&req)).unwrap_err();
        assert_eq!(err.code(), "mapping_restricted_column", "{header}");
        assert!(!format!("{err:?}").contains("SECRET_PII_CELL"));
    }

    let ok_sheet = sheet("s", &[&[name, worksite_addr], &["A", "Plant 1 Road"]]);
    let ok_req = SheetMappingRequest {
        header_row: Some(1),
        columns: BTreeMap::from([
            ("A".into(), Some("name".into())),
            ("B".into(), Some("worksite_address".into())),
        ]),
        skip: Some(false),
    };
    let (_, cols) = mapped(detect(&ok_sheet, &none(), Some(&ok_req)).unwrap());
    assert_eq!(cols[1], ("B".into(), Some("worksite_address")));
}
