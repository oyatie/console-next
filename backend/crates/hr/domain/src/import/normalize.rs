//! IMPORT-2 typed normalisation of the cells a plan decides on: 재직상태,
//! 휴직 유형 and 사번. A text the catalog does not know is `None`, and the
//! dry run turns that into a 확인 필요 item the operator maps (remembered per
//! tenant); nothing is guessed.

use super::classification::import_header_match_key;
use crate::lifecycle::leave_facts::LEAVE_TYPES;

/// The statuses an import records as a setup fact (decisions #26).
pub const STATUS_CODES: [&str; 4] = ["ACTIVE", "ON_LEAVE", "EXITED", "PRE_HIRE"];

const STATUS_WORDS: &[(&str, &str)] = &[
    ("재직", "ACTIVE"),
    ("재직중", "ACTIVE"),
    ("근무", "ACTIVE"),
    ("근무중", "ACTIVE"),
    ("active", "ACTIVE"),
    ("휴직", "ON_LEAVE"),
    ("휴직중", "ON_LEAVE"),
    ("on_leave", "ON_LEAVE"),
    ("퇴사", "EXITED"),
    ("퇴직", "EXITED"),
    ("퇴사자", "EXITED"),
    ("퇴직자", "EXITED"),
    ("exited", "EXITED"),
    ("입사예정", "PRE_HIRE"),
    ("pre_hire", "PRE_HIRE"),
];

const LEAVE_WORDS: &[(&str, &str)] = &[
    ("육아휴직", "CHILDCARE"),
    ("육아", "CHILDCARE"),
    ("출산전후휴가", "MATERNITY"),
    ("출산휴가", "MATERNITY"),
    ("출산", "MATERNITY"),
    ("질병휴직", "ILLNESS"),
    ("병가", "ILLNESS"),
    ("질병", "ILLNESS"),
    ("개인휴직", "PERSONAL"),
    ("개인사유", "PERSONAL"),
    ("개인", "PERSONAL"),
    ("기타", "OTHER"),
];

/// W02: 고용형태 labels with one meaning in a Korean roster. A label that
/// could mean two codes is not here: it is asked, with [`EMPLOYMENT_TYPE_LIKELY`]
/// first among the choices. The codes themselves map too.
const EMPLOYMENT_TYPE_WORDS: &[(&str, &str)] = &[
    ("정규", "REGULAR"),
    ("정규직", "REGULAR"),
    ("정규직원", "REGULAR"),
    ("정직원", "REGULAR"),
    ("상용", "REGULAR"),
    ("상용직", "REGULAR"),
    ("계약", "CONTRACT"),
    ("계약직", "CONTRACT"),
    ("기간제", "CONTRACT"),
    ("기간제근로자", "CONTRACT"),
    ("파트타임", "PART_TIME"),
    ("시간제", "PART_TIME"),
    ("단시간", "PART_TIME"),
    ("단시간근로자", "PART_TIME"),
    ("인턴", "INTERN"),
    ("일용", "DAILY"),
    ("일용직", "DAILY"),
    ("임원", "EXECUTIVE"),
    ("프리랜서", "FREELANCE"),
];

/// W02: labels that are asked, with this code offered first.
const EMPLOYMENT_TYPE_LIKELY: &[(&str, &str)] = &[
    ("촉탁", "CONTRACT"),
    ("촉탁직", "CONTRACT"),
    ("파견", "DISPATCHED_IN"),
    ("파견직", "DISPATCHED_IN"),
    ("아르바이트", "PART_TIME"),
    ("알바", "PART_TIME"),
    ("도급", "OUTSOURCED_ON_SITE"),
    ("용역", "OUTSOURCED_ON_SITE"),
    ("위촉", "FREELANCE"),
];

fn lookup(
    words: &[(&str, &'static str)],
    codes: &[&'static str],
    text: &str,
) -> Option<&'static str> {
    let key = import_header_match_key(text);
    codes
        .iter()
        .find(|code| import_header_match_key(code) == key)
        .copied()
        .or_else(|| {
            words
                .iter()
                .find(|(word, _)| import_header_match_key(word) == key)
                .map(|(_, code)| *code)
        })
}

/// A 재직상태 cell as a status code; `None`: not in the catalog.
#[must_use]
pub fn status_code(text: &str) -> Option<&'static str> {
    lookup(STATUS_WORDS, &STATUS_CODES, text)
}

/// A 휴직 유형 cell as a `LEAVE_TYPES` code; `None`: not in the catalog.
#[must_use]
pub fn leave_type_code(text: &str) -> Option<&'static str> {
    lookup(LEAVE_WORDS, &LEAVE_TYPES, text)
}

/// A 고용형태 cell as an employment type code: the code itself or a label
/// with one meaning (W02); `None`: the operator is asked.
#[must_use]
pub fn employment_type_code(text: &str) -> Option<&'static str> {
    lookup(EMPLOYMENT_TYPE_WORDS, EMPLOYMENT_TYPE_CODES, text)
}

/// The choices offered for a 고용형태 label nobody mapped: the likely code
/// first (if the label has one), then every code.
#[must_use]
pub fn employment_type_choices(text: &str) -> Vec<&'static str> {
    let likely = lookup(EMPLOYMENT_TYPE_LIKELY, &[], text);
    likely
        .into_iter()
        .chain(
            EMPLOYMENT_TYPE_CODES
                .iter()
                .copied()
                .filter(|c| Some(*c) != likely),
        )
        .collect()
}

const EMPLOYMENT_TYPE_CODES: &[&str] = &[
    "REGULAR",
    "CONTRACT",
    "PART_TIME",
    "INTERN",
    "DAILY",
    "EXECUTIVE",
    "DISPATCHED_IN",
    "OUTSOURCED_ON_SITE",
    "FREELANCE",
];

/// A known status or leave-type code by its own spelling (an operator's map).
#[must_use]
pub fn known_code(kind: &str, code: &str) -> Option<&'static str> {
    let codes: &[&'static str] = match kind {
        "status" => &STATUS_CODES,
        _ => &LEAVE_TYPES,
    };
    codes.iter().find(|c| **c == code).copied()
}

/// A 사번 cell: trimmed, and a whole number Excel stored as a float
/// (`1001.0`) without its fraction. `None` when empty.
#[must_use]
pub fn employee_number(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let whole = trimmed
        .strip_suffix(".0")
        .filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(trimmed);
    (!whole.is_empty()).then(|| whole.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_and_leave_types_map_by_catalog_only() {
        assert_eq!(status_code(" 재직 "), Some("ACTIVE"));
        assert_eq!(status_code("휴직 중"), Some("ON_LEAVE"));
        assert_eq!(status_code("ON_LEAVE"), Some("ON_LEAVE"));
        assert_eq!(status_code("퇴사"), Some("EXITED"));
        assert_eq!(status_code("파견"), None);
        assert_eq!(leave_type_code("육아휴직"), Some("CHILDCARE"));
        assert_eq!(leave_type_code("OTHER"), Some("OTHER"));
        assert_eq!(leave_type_code("연수"), None);
        assert_eq!(known_code("status", "EXITED"), Some("EXITED"));
        assert_eq!(known_code("leave_type", "EXITED"), None);
    }

    /// regression (W02): 「정규직」 and 「정규」 came back unmapped and 300
    /// people were applied with no 고용형태.
    #[test]
    fn regression_common_employment_type_labels_map_without_asking() {
        for (label, code) in [
            ("정규", "REGULAR"),
            ("정규직", "REGULAR"),
            (" 정규 직 ", "REGULAR"),
            ("계약", "CONTRACT"),
            ("계약직", "CONTRACT"),
            ("기간제", "CONTRACT"),
            ("일용직", "DAILY"),
            ("contract", "CONTRACT"),
            ("PART_TIME", "PART_TIME"),
        ] {
            assert_eq!(employment_type_code(label), Some(code), "{label}");
        }
    }

    #[test]
    fn an_ambiguous_employment_type_label_is_asked_with_its_likely_code_first() {
        for label in ["촉탁", "파견", "아르바이트", "도급", "위촉", "무기계약", ""]
        {
            assert_eq!(employment_type_code(label), None, "{label}");
        }
        assert_eq!(employment_type_choices("촉탁")[0], "CONTRACT");
        assert_eq!(employment_type_choices("파견")[0], "DISPATCHED_IN");
        let choices = employment_type_choices("무기계약");
        assert_eq!(
            choices, EMPLOYMENT_TYPE_CODES,
            "no likely code: catalog order"
        );
        assert_eq!(
            employment_type_choices("촉탁").len(),
            EMPLOYMENT_TYPE_CODES.len()
        );
    }

    #[test]
    fn the_employment_type_codes_are_the_profile_enum() {
        use crate::profile::enums::EmploymentType;
        let codes: Vec<_> = EmploymentType::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(codes, EMPLOYMENT_TYPE_CODES);
        for (_, code) in EMPLOYMENT_TYPE_WORDS.iter().chain(EMPLOYMENT_TYPE_LIKELY) {
            assert!(EmploymentType::parse(code).is_ok(), "{code}");
        }
    }

    #[test]
    fn employee_numbers_lose_only_a_float_fraction() {
        assert_eq!(employee_number(" 1001.0 "), Some("1001".into()));
        assert_eq!(employee_number("E-1001"), Some("E-1001".into()));
        assert_eq!(employee_number("A.0"), Some("A.0".into()));
        assert_eq!(employee_number("  "), None);
    }
}
