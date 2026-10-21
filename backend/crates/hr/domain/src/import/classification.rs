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

pub fn employee_import_column_classification(header: &str, target: Option<&str>) -> &'static str {
    if let Some(field) = target.and_then(employee_import_field_for_target) {
        return field.classification;
    }
    if is_restricted_employee_import_header(header) {
        return "restricted";
    }
    if is_location_header(header) {
        return "location";
    }
    if target.is_some() {
        return "canonical";
    }
    "retained"
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

/// A restricted header no canonical target claims: its cells never persist.
pub fn is_dropped_employee_import_header(header: &str) -> bool {
    employee_import_column_classification(header, employee_import_target_for_header(header))
        == "restricted"
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
