//! Text guards shared by every section: trim, length, no control characters,
//! and no 고유식별정보 typed into a free-text field (개인정보 보호법 §24,
//! §24조의2; 시행령 §19). Migration 0261 repeats the RRN and licence shapes as
//! CHECKs for any other writer.

use console_kernel_core::KernelError;

use crate::import::rrn::is_rrn_value;

pub(crate) fn required_text(
    value: String,
    max_chars: usize,
    field: &'static str,
) -> Result<String, KernelError> {
    optional_text(Some(value), max_chars, field)?
        .ok_or_else(|| KernelError::validation(format!("{field} is required")))
}

pub(crate) fn optional_text(
    value: Option<String>,
    max_chars: usize,
    field: &'static str,
) -> Result<Option<String>, KernelError> {
    let Some(value) = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > max_chars {
        return Err(KernelError::validation(format!(
            "{field} must be {max_chars} characters or fewer"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(KernelError::validation(format!(
            "{field} must not contain control characters"
        )));
    }
    if is_rrn_value(&value) {
        return Err(KernelError::validation(format!(
            "{field} must not hold a resident or foreigner registration number"
        )));
    }
    Ok(Some(value))
}

/// A 운전면허번호 or 여권번호 shape, refused in a certificate number of any
/// kind (고유식별정보, 시행령 §19): exactly 12 digits once separators are dropped
/// (`11-23-456789-01`), a two-letter Hangul region and 10 digits (the older
/// `서울 23-456789-01`), or a passport number (`M12345678`, `M123A4567`).
#[must_use]
pub fn looks_like_identifier_number(value: &str) -> bool {
    let digits = value.chars().filter(char::is_ascii_digit).count();
    if digits == 12 {
        return true;
    }
    let hangul = value
        .chars()
        .take_while(|c| !c.is_ascii_digit())
        .filter(|c| ('\u{AC00}'..='\u{D7A3}').contains(c))
        .count();
    if hangul >= 2 && digits == 10 {
        return true;
    }
    let b: Vec<char> = value.trim().chars().collect();
    let letter = |i: usize| b.get(i).is_some_and(char::is_ascii_alphabetic);
    let digit = |r: std::ops::Range<usize>| {
        r.clone()
            .all(|i| b.get(i).is_some_and(char::is_ascii_digit))
    };
    b.len() == 9 && letter(0) && (digit(1..9) || (digit(1..4) && letter(4) && digit(5..9)))
}
