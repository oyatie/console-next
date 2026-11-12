//! Employee import header normalisation and column classification
//! (canonical, restricted, location, retained), moved from `app/src/hr.rs`
//! (R2-import).

use super::fields::{EMPLOYEE_IMPORT_FIELD_DEFINITIONS, EmployeeImportFieldDefinition};
use super::pii as import_pii;

pub fn normalize_header_label(raw: &str) -> String {
    raw.chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
}

pub fn import_header_match_key(header: &str) -> String {
    normalize_header_label(header)
        .chars()
        .filter(|ch| {
            !matches!(
                ch,
                '(' | ')' | '[' | ']' | '{' | '}' | '_' | '-' | '/' | '\\' | '.' | '·' | ':'
            )
        })
        .collect::<String>()
        .to_ascii_lowercase()
}

pub fn employee_import_target_for_header(header: &str) -> Option<&'static str> {
    employee_import_field_for_header(header).map(|field| field.target)
}

/// How a column is treated. Only a column a field takes is stored: one with
/// no target is `restricted` whatever its header says, so a roster's pay,
/// bank or note columns never persist because no word list named them.
/// (`retained`, raw text kept without a field, is no longer produced.)
pub fn employee_import_column_classification(header: &str, target: Option<&str>) -> &'static str {
    if let Some(field) = target.and_then(employee_import_field_for_target) {
        return field.classification;
    }
    if target.is_none() || is_restricted_employee_import_header(header) {
        return "restricted";
    }
    if is_location_header(header) {
        return "location";
    }
    "canonical"
}

pub fn employee_import_field_for_header(
    header: &str,
) -> Option<&'static EmployeeImportFieldDefinition> {
    let key = import_header_match_key(header);
    EMPLOYEE_IMPORT_FIELD_DEFINITIONS.iter().find(|field| {
        field
            .aliases
            .iter()
            .any(|alias| import_header_match_key(alias) == key)
    })
}

pub fn employee_import_field_for_target(
    target: &str,
) -> Option<&'static EmployeeImportFieldDefinition> {
    EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .find(|field| field.target == target)
}

pub fn is_location_header(header: &str) -> bool {
    header.contains("위치") || header.contains("주소")
}

/// A header that is restricted by its own wording (a restricted field's
/// label, or a restricted word no built-in field claims): its cells never
/// persist, even when the operator maps the column to another field.
pub fn is_dropped_employee_import_header(header: &str) -> bool {
    match employee_import_field_for_header(header) {
        Some(field) => field.classification == "restricted",
        None => is_restricted_employee_import_header(header),
    }
}

pub fn is_restricted_employee_import_header(header: &str) -> bool {
    let restricted_fragments = [
        "주민",
        "급여",
        "시급",
        "통상",
        "수당",
        "국민연금",
        "건강보험",
        "고용보험",
        "산재",
        "소득세",
        "은행",
        "계좌",
        "장애",
        "퇴직금",
        "지급일",
        "급여산정",
        "휴대폰",
        "핸드폰",
        "전화",
        "연락처",
        "개인주소",
        "거주주소",
    ];
    restricted_fragments
        .iter()
        .any(|fragment| header.contains(fragment))
        || import_pii::is_pii2_restricted_header(header)
}

pub fn target_header_aliases(target: &str) -> &'static [&'static str] {
    employee_import_field_for_target(target)
        .map(|field| field.aliases)
        .unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// regression: a roster's pay columns (base pay, bonus, transport allowance)
    /// were kept as raw text because no restricted word named them.
    #[test]
    fn regression_a_column_no_field_takes_is_never_stored() {
        for header in [
            "기본급",
            "상여금",
            "교통비",
            "비고",
            "국적",
            "현주소",
            "Remarks",
        ] {
            assert_eq!(
                employee_import_column_classification(header, None),
                "restricted",
                "{header}"
            );
        }
        // A mapped column keeps its field's treatment, whatever its header.
        assert_eq!(
            employee_import_column_classification("소속팀", Some("org_unit")),
            "canonical"
        );
        assert_eq!(
            employee_import_column_classification("연락처", Some("phone")),
            "restricted"
        );
        assert_eq!(
            employee_import_column_classification("주민등록번호", Some("rrn")),
            "restricted"
        );
        // A header's own wording is judged apart from the mapping: a column the
        // operator maps under a custom header still reaches the stored row.
        assert!(!is_dropped_employee_import_header("소속팀"));
        assert!(is_dropped_employee_import_header("급여계좌"));
        assert!(is_dropped_employee_import_header("연락처"));
    }
}
