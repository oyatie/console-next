//! Worker register sex of an imported person (Labor Standards Act Enforcement Decree Art. 20):
//! reads the explicit sex column when provided, and intentionally falls back to deriving sex from
//! the 7th digit (odd = MALE, even = FEMALE across RRN, ARC, and DOMESTIC_RESIDENCE) when omitted.
//! Only that derived value leaves the parser; the registration number itself is sealed and never
//! stored in canonical import rows.

/// A sex cell as people write it, as `MALE` / `FEMALE`; anything else is no
/// answer (never a guess).
#[must_use]
pub fn sex_of_text(raw: &str) -> Option<&'static str> {
    match raw.trim().to_uppercase().as_str() {
        "남" | "남자" | "남성" | "M" | "MALE" | "男" => Some("MALE"),
        "여" | "여자" | "여성" | "F" | "FEMALE" | "女" => Some("FEMALE"),
        _ => None,
    }
}

/// The sex a 13-digit resident registration number (or alien registration
/// number) states in its 7th digit.
#[must_use]
pub fn sex_of_rrn(digits: &str) -> Option<&'static str> {
    let digit = digits.chars().nth(6)?.to_digit(10)?;
    Some(if digit % 2 == 1 { "MALE" } else { "FEMALE" })
}

#[cfg(test)]
mod tests {
    use super::{sex_of_rrn, sex_of_text};

    #[test]
    fn a_sex_cell_reads_its_words_and_nothing_else() {
        assert_eq!(sex_of_text(" 남 "), Some("MALE"));
        assert_eq!(sex_of_text("여성"), Some("FEMALE"));
        assert_eq!(sex_of_text("f"), Some("FEMALE"));
        assert_eq!(sex_of_text("남자?"), None);
        assert_eq!(sex_of_text(""), None);
    }

    #[test]
    fn the_seventh_digit_states_it_for_every_century_and_foreigners() {
        for (digits, sex) in [
            ("7006062000000", "FEMALE"),
            ("7006061000000", "MALE"),
            ("0101013000000", "MALE"),
            ("0101014000000", "FEMALE"),
            ("9001015000000", "MALE"),
            ("9001016000001", "FEMALE"),
        ] {
            assert_eq!(sex_of_rrn(digits), Some(sex), "{digits}");
        }
        assert_eq!(sex_of_rrn("700606"), None);
    }
}
