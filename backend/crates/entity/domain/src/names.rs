//! Registered names are compared without rewriting their printed spelling.
use crate::{Issues, Refusal};
use serde::Deserialize;

#[must_use]
pub fn name_key(raw: &str) -> String {
    let width = width_key(raw);
    let mut name = width.as_str();
    for marker in ["주식회사", "(주)"] {
        name = name.strip_prefix(marker).unwrap_or(name);
        name = name.strip_suffix(marker).unwrap_or(name);
    }
    name.to_owned()
}

#[must_use]
pub fn width_key(raw: &str) -> String {
    let mut width = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c == '㈜' {
            width.push_str("(주)");
            continue;
        }
        let c = if ('\u{ff01}'..='\u{ff5e}').contains(&c) {
            char::from_u32(u32::from(c) - 0xfee0).unwrap_or(c)
        } else {
            c
        };
        if !c.is_whitespace() {
            width.push(c);
        }
    }
    width
}

/// Person data in a name field: one of the 대표자 names, or a list of person names.
#[must_use]
pub fn is_person(name: &str, representatives: &[String]) -> bool {
    let key = width_key(name);
    let people: std::collections::BTreeSet<_> = representatives
        .iter()
        .filter(|r| !r.trim().is_empty())
        .map(|r| width_key(r))
        .collect();
    let parts: Vec<_> = name
        .split([',', '，', '、', ';', '；', '/', '\n', '·', '&', '+'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let person_list = parts.len() > 1
        && parts.iter().all(|p| {
            name_key(p) == width_key(p)
                && (p
                    .chars()
                    .all(|c| ('가'..='힣').contains(&c) || c.is_whitespace())
                    || people.contains(&width_key(p)))
        });
    people.contains(&key) || person_list
}

/// The three name facts of a 법인 and the refusal each gives to person data.
pub const PERSON_CODES: [(&str, &str); 3] = [
    ("name", "legal_name_is_person"),
    ("display_name", "display_name_is_person"),
    ("english_name", "english_name_is_person"),
];

/// 영문명: Latin letters, digits, spaces and common corporate punctuation only.
#[must_use]
pub fn is_latin_name(name: &str) -> bool {
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || " &.,-'()".contains(c))
}

/// Reject person data in any name field, retaining the caller's input.
pub fn validate_names(names: [Option<&str>; 3], representatives: &[String]) -> Result<(), Refusal> {
    let mut refusal: Option<Refusal> = None;
    for ((field, code), name) in PERSON_CODES.into_iter().zip(names) {
        if name.is_some_and(|n| is_person(n, representatives)) {
            match &mut refusal {
                Some(r) => r.fields.extend(Refusal::field(field, code).fields),
                None => refusal = Some(Refusal::field(field, code)),
            }
        }
    }
    refusal.map_or(Ok(()), Err)
}

/// Omission preserves an optional field; explicit null clears it.
pub(crate) fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

pub(crate) fn optional_text(
    is: &mut Issues,
    field: &str,
    raw: &Option<Option<String>>,
    max: usize,
) -> Option<Option<String>> {
    raw.as_ref()
        .map(|v| is.text(field, v.as_deref(), max, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn omission_null_and_text_are_distinct_revision_commands() {
        for (json, expected) in [
            ("{}", None),
            (r#"{"english_name":null}"#, Some(None)),
            (
                r#"{"english_name":"  Ganatech  "}"#,
                Some(Some("Ganatech".to_owned())),
            ),
        ] {
            let input: crate::legal_entity::LegalEntityInput = serde_json::from_str(json).unwrap();
            let mut issues = Issues::default();
            assert_eq!(
                optional_text(&mut issues, "english_name", &input.english_name, 200),
                expected
            );
        }
    }
    #[test]
    fn spelling_variants_compare_but_romanization_does_not() {
        for v in [
            "주식회사 가나테크",
            "가나테크 (주)",
            "㈜가나테크",
            "（주） 가나테크",
        ] {
            assert_eq!(name_key(v), "가나테크");
        }
        assert_ne!(name_key("GANATECH"), name_key("주식회사 가나테크"));
        assert_ne!(name_key("가나주식회사상사"), name_key("가나상사"));
        assert_eq!(name_key(&name_key("㈜ 가나테크")), name_key("㈜ 가나테크"));
    }
    #[test]
    fn refuses_person_data_in_each_name_field_with_its_pointer() {
        let reps = ["김예시".to_owned(), "John Doe".into(), "Jane Doe".into()];
        for name in [
            "김예시",
            "김예시,박예시",
            "김예시， 박예시",
            "John Doe;Jane Doe",
        ] {
            let r = validate_names([Some(name), Some(name), Some(name)], &reps).unwrap_err();
            let got: Vec<_> = r
                .fields
                .iter()
                .map(|f| (f.field.as_str(), f.code))
                .collect();
            assert_eq!(got, PERSON_CODES.to_vec());
        }
        let r = validate_names([Some("주식회사 누리"), Some("김예시,박예시"), None], &reps)
            .unwrap_err();
        assert_eq!(
            (r.fields[0].field.as_str(), r.fields[0].code),
            ("display_name", "display_name_is_person")
        );
        for name in [
            "주식회사 김예시",
            "주식회사 가나테크",
            "Acme, Inc",
            "Black & Decker",
            "주식회사 가나,주식회사 나다",
        ] {
            assert!(!is_person(name, &reps[..1]), "{name}");
        }
    }
    #[test]
    fn english_names_allow_latin_and_corporate_punctuation_only() {
        for ok in ["Ganatech Co., Ltd.", "A&B (Korea) Inc", "O'Neil-Kim 2"] {
            assert!(is_latin_name(ok), "{ok}");
        }
        for bad in [
            "주식회사 가나테크",
            "Ganatech 가나테크",
            "Ganatech/Seoul",
            "ＧＡＮＡＴＥＣＨ",
        ] {
            assert!(!is_latin_name(bad), "{bad}");
        }
    }
}
