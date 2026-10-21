use super::*;
use crate::import::grid::{Cell, GridRow};

fn row(cells: &[&str]) -> GridRow {
    GridRow {
        index: 9,
        cells: cells
            .iter()
            .enumerate()
            .filter(|(_, t)| !t.is_empty())
            .map(|(c, t)| (u32::try_from(c).unwrap(), Cell::Text((*t).into())))
            .collect(),
    }
}

/// regression (W12): 「합계 | 300명」 became a person named 「300명」.
#[test]
fn regression_a_totals_row_is_not_a_person() {
    // 사번, 성명, 입사일
    assert!(is_summary_row(
        &row(&["합계", "300명", ""]),
        Some(1),
        Some(2)
    ));
    assert!(is_summary_row(&row(&["", "합 계", ""]), Some(1), Some(2)));
    assert!(is_summary_row(
        &row(&["Total", "1,234", ""]),
        Some(1),
        Some(2)
    ));
    assert!(is_summary_row(&row(&["소계", "", ""]), Some(1), Some(2)));
}

#[test]
fn a_person_is_never_a_totals_row() {
    // A person named 「계」 with an 입사일, a 성명 next to a 합계 note, no token.
    assert!(!is_summary_row(
        &row(&["E-1", "계", "2024-03-04"]),
        Some(1),
        Some(2)
    ));
    assert!(!is_summary_row(
        &row(&["합계", "김일", ""]),
        Some(1),
        Some(2)
    ));
    assert!(!is_summary_row(
        &row(&["E-2", "300명", ""]),
        Some(1),
        Some(2)
    ));
    assert!(!is_summary_row(&row(&["", "", ""]), Some(1), Some(2)));
}

/// regression (W12): 연락처 was dropped (저장하지 않음), so every imported
/// person had 휴대전화 미등록; a number cell also lost its leading 0.
#[test]
fn regression_phone_cells_read_as_e164() {
    for (cell, e164) in [
        ("010-1234-5678", "+821012345678"),
        ("1012345678", "+821012345678"),
        ("０１０ １２３４ ５６７８", "+821012345678"),
        ("02-123-4567", "+8221234567"),
        ("21234567", "+8221234567"),
        ("1588-1234", "+8215881234"),
        ("15881234", "+8215881234"),
        ("+82 10 1234 5678", "+821012345678"),
        ("821012345678", "+821012345678"),
    ] {
        assert_eq!(import_phone(cell).as_deref(), Some(e164), "{cell}");
    }
}

#[test]
fn a_cell_that_is_not_a_phone_number_is_none() {
    for cell in ["", "없음", "010-12", "연락처", "010-1234-5678a"] {
        assert_eq!(import_phone(cell), None, "{cell}");
    }
}

#[test]
fn sheet_memory_keys_never_collide_with_header_keys() {
    assert_eq!(sheet_memory_key(" 참고 사항 "), "sheet:참고사항");
    assert!(!memory_key("sheet:참고사항").contains(':'));
}
