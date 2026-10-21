//! Any-layout parse of synthetic sheets (values are made up): the R2-import
//! header and privacy cases on the IMPORT-2 path, and the new ones.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;

use console_hr_domain::import::detect::{SheetMappingRequest, WorkbookMappingRequest};
use console_hr_domain::import::grid::{Cell, GridRow, GridSheet};
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use serde_json::json;
use uuid::Uuid;

use super::{SheetContext, cell_json};
use crate::import::mask::masked_preview_values;
use crate::import::parsed::ImportRowStatus;
use crate::import::workbook::parse_workbook;

pub(crate) fn grid(name: &str, cells: &[(u32, u32, Cell)]) -> GridSheet {
    let mut rows: Vec<GridRow> = Vec::new();
    for (row, col, cell) in cells {
        match rows.iter_mut().find(|r| r.index == *row) {
            Some(r) => r.cells.push((*col, cell.clone())),
            None => rows.push(GridRow {
                index: *row,
                cells: vec![(*col, cell.clone())],
            }),
        }
    }
    rows.sort_by_key(|r| r.index);
    GridSheet {
        name: name.into(),
        rows,
    }
}

fn t(text: &str) -> Cell {
    Cell::Text(text.into())
}

/// Test-only: "seals" by reversing the digits. Not cryptography.
struct Mirror;
impl RrnVault for Mirror {
    fn seal(&self, _org: Uuid, rrn: &Rrn) -> Result<SealedRrn, VaultError> {
        Ok(SealedRrn {
            hmac: self.blind_index(rrn),
            hmac_key_version: 1,
            ciphertext: rrn.digits().bytes().rev().chain([0u8; 8]).collect(),
            nonce: vec![0; 24],
            dek_wrapped: vec![0; 16],
            dek_nonce: vec![0; 24],
            key_version: 1,
            masked: rrn.masked(),
        })
    }
    fn blind_index(&self, rrn: &Rrn) -> Vec<u8> {
        rrn.digits().bytes().cycle().take(32).collect()
    }
    fn open(&self, _org: Uuid, _sealed: &SealedRrn) -> Result<Rrn, VaultError> {
        Err(VaultError)
    }
}

fn parse(
    sheets: &[GridSheet],
    vault: Option<&dyn RrnVault>,
    mapping: &WorkbookMappingRequest,
) -> crate::import::parsed::ParsedEmployeeImportWorkbook {
    let ctx = SheetContext {
        filename: "employees.xlsx",
        org: Uuid::nil(),
        vault,
    };
    parse_workbook(&ctx, sheets, &BTreeMap::new(), mapping).unwrap()
}

#[test]
fn a_header_below_title_rows_maps_moved_columns() {
    let sheet = grid(
        "원천",
        &[
            (0, 0, t("2026년 임직원 명부")),
            (1, 0, t("직원번호")),
            (1, 1, t("이름")),
            (1, 2, t("법인")),
            (2, 0, t("ALT-010")),
            (2, 1, t("김표준")),
            (2, 2, t("운영법인")),
        ],
    );
    let parsed = parse(&[sheet], None, &WorkbookMappingRequest::default());
    assert_eq!(parsed.rows.len(), 1);
    assert_eq!(parsed.rows[0].source_row, 3);
    assert_eq!(parsed.rows[0].company, "운영법인");
    assert_eq!(parsed.rows[0].source_metadata["header_row"], json!(2));
    assert_eq!(
        parsed.rows[0].source_metadata["company_source"],
        json!("mapped_column")
    );
    assert_eq!(parsed.rows[0].source_metadata["cells"]["name"], json!("B3"));
    assert!(
        parsed.columns.iter().any(
            |c| c.source_header == "직원번호" && c.target.as_deref() == Some("employee_number")
        )
    );
}

#[test]
fn restricted_cells_never_enter_a_raw_row_and_previews_mask() {
    let sheet = grid(
        "새온",
        &[
            (0, 0, t("성명")),
            (0, 1, t("근무지\n(주소)")),
            (0, 2, t("계좌번호")),
            (0, 3, t("퇴직금 중간정산일")),
            (0, 4, t("메모")),
            (1, 0, t("홍길동")),
            (1, 1, t("서울")),
            (1, 2, t("123-456")),
            (1, 3, t("2025-12-31")),
            (1, 4, t("현장 배치")),
            (2, 2, t("빈 이름 원천 행")),
        ],
    );
    let parsed = parse(&[sheet], None, &WorkbookMappingRequest::default());
    assert_eq!(parsed.rows.len(), 2);
    assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Candidate);
    assert_eq!(parsed.rows[1].row_status, ImportRowStatus::Preserved);
    assert_eq!(parsed.rows[0].raw_row["근무지(주소)"], json!("서울"));
    assert_eq!(parsed.rows[1].raw_row.get("계좌번호"), None);
    assert_eq!(
        parsed.rows[0].source_metadata["dropped_restricted_columns"],
        json!(["계좌번호", "퇴직금중간정산일"])
    );
    let preview = masked_preview_values(&parsed.rows[0].raw_row, &parsed.columns);
    assert_eq!(preview["근무지(주소)"], json!("••••"));
    assert_eq!(preview.get("계좌번호"), None);
    assert_eq!(preview["메모"], json!("현장 배치"));
}

#[test]
fn shuffled_alias_headers_map_without_position_assumptions() {
    let sheet = grid(
        "원천시트",
        &[
            (0, 0, t("메모")),
            (0, 1, t("직원번호")),
            (0, 2, t("남은 연차")),
            (0, 3, t("근무지 주소")),
            (0, 4, t("이름")),
            (0, 5, t("계열사")),
            (1, 0, t("현장 배치")),
            (1, 1, t("ALT-001")),
            (1, 2, Cell::Float(7.5)),
            (1, 3, t("서울")),
            (1, 4, t("홍길동")),
            (1, 5, t("새온")),
            (2, 0, t("raw-only keep")),
        ],
    );
    let parsed = parse(&[sheet], None, &WorkbookMappingRequest::default());
    assert_eq!(parsed.rows[0].company, "새온");
    let canonical = parsed.rows[0].canonical.as_ref().unwrap();
    assert_eq!(canonical.employee_number.as_deref(), Some("ALT-001"));
    assert_eq!(canonical.leave_remaining.as_deref(), Some("7.500000"));
    assert_eq!(canonical.worksite_address.as_deref(), Some("서울"));
    let preview = masked_preview_values(&parsed.rows[0].raw_row, &parsed.columns);
    assert_eq!(preview["남은연차"], json!(7.5));
    assert_eq!(parsed.rows[1].row_status, ImportRowStatus::Preserved);
}

#[test]
fn an_rrn_column_is_sealed_apart_or_dropped_and_never_in_the_raw_row() {
    let sheet = grid(
        "명부",
        &[
            (0, 0, t("성명")),
            (0, 1, t("주민등록번호")),
            (0, 2, t("사번")),
            (1, 0, t("가")),
            (1, 1, t("900101-1234567")),
            (1, 2, Cell::Float(1001.0)),
            (2, 0, t("나")),
            (2, 1, t("12-34")),
        ],
    );
    let sealed = parse(
        std::slice::from_ref(&sheet),
        Some(&Mirror),
        &WorkbookMappingRequest::default(),
    );
    assert_eq!(sealed.identities.len(), 1);
    assert_eq!(sealed.identities[0].sealed.masked, "900101-1******");
    assert_eq!(
        sealed.rows[0]
            .canonical
            .as_ref()
            .unwrap()
            .employee_number
            .as_deref(),
        Some("1001")
    );
    let reasons: Vec<_> = sealed
        .notes
        .iter()
        .map(|n| (n.reason, n.cell.clone()))
        .collect();
    assert_eq!(reasons, [("rrn_invalid", Some("B3".into()))]);
    for row in &sealed.rows {
        assert!(!row.raw_row.to_string().contains("1234567"));
        assert!(!row.source_metadata.to_string().contains("1234567"));
    }
    let dropped = parse(&[sheet], None, &WorkbookMappingRequest::default());
    assert!(dropped.identities.is_empty());
    assert!(dropped.notes.iter().any(|n| n.reason == "rrn_unavailable"));
}

#[test]
fn an_unrecognised_sheet_is_reported_and_keeps_no_cell_until_mapped() {
    let log = grid(
        "업무일지",
        &[
            (0, 0, t("일자")),
            (0, 1, t("담당")),
            (0, 2, t("작업")),
            (1, 0, t("2026-05-27")),
            (1, 1, t("가")),
            (1, 2, t("점검")),
        ],
    );
    let parsed = parse(
        std::slice::from_ref(&log),
        None,
        &WorkbookMappingRequest::default(),
    );
    assert!(parsed.rows.is_empty());
    assert_eq!(parsed.notes[0].reason, "sheet_needs_mapping");
    assert!(parsed.notes[0].blocking);
    assert_eq!(parsed.sheets[0]["status"], "needs_mapping");
    assert!(
        parsed.sheets[0].get("header_candidates").is_none(),
        "never stored"
    );
    assert_eq!(parsed.shown[0]["header_candidates"][0]["row"], 1);
    let mapping = WorkbookMappingRequest {
        sheets: BTreeMap::from([(
            "업무일지".into(),
            SheetMappingRequest {
                header_row: Some(1),
                columns: BTreeMap::from([("B".into(), Some("name".into())), ("C".into(), None)]),
                skip: None,
            },
        )]),
    };
    let mapped = parse(&[log], None, &mapping);
    assert_eq!(mapped.rows.len(), 1);
    assert_eq!(mapped.rows[0].name.as_deref(), Some("가"));
    assert_eq!(
        mapped.remembered,
        [
            ("담당".to_owned(), Some("name".to_owned())),
            ("작업".to_owned(), None)
        ]
    );
    let ctx = SheetContext {
        filename: "f",
        org: Uuid::nil(),
        vault: None,
    };
    let unknown = WorkbookMappingRequest {
        sheets: BTreeMap::from([("없음".into(), SheetMappingRequest::default())]),
    };
    let error = parse_workbook(&ctx, &[], &BTreeMap::new(), &unknown).unwrap_err();
    assert_eq!(error.code, "mapping_unknown_sheet");
}

#[test]
fn property_cells_become_json_without_panicking() {
    let mut seed = 0xDEAD_BEEF_CAFE_F00Du64;
    for _ in 0..2_000 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let cell = match seed % 4 {
            0 => Cell::Float(f64::from_bits(seed >> 2)),
            1 => Cell::Int(seed as i64),
            2 => Cell::Text(format!("{seed:x}")),
            _ => Cell::Bool(seed.is_multiple_of(2)),
        };
        let value = cell_json(Some(&cell));
        assert!(serde_json::to_string(&value).is_ok());
    }
}
