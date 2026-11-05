//! 주민등록번호 (RRN) value detection for import cells, headers, file and
//! sheet names (moved from `app/src/hr.rs`, R2-import).

use super::rrn_value::Rrn;

/// Every spelling the vault accepts, plus embedded RRN shapes even when the
/// birth date is invalid. Used for cells, headers, names and stored text.
pub fn is_rrn_value(text: &str) -> bool {
    contains_rrn_shaped(text) || Rrn::parse(text).is_ok()
}

/// `\d{6}-?[1-8]\d{6}` not touching another digit. Migration 0247 scrubs
/// stored rows with the same rule.
pub fn contains_rrn_shaped(text: &str) -> bool {
    let b = text.as_bytes();
    let digits = |from: usize, n: usize| {
        b.get(from..from + n)
            .is_some_and(|run| run.iter().all(u8::is_ascii_digit))
    };
    (0..b.len()).any(|start| {
        if (start > 0 && b[start - 1].is_ascii_digit()) || !digits(start, 6) {
            return false;
        }
        let mut i = start + 6;
        if b.get(i) == Some(&b'-') {
            i += 1;
        }
        matches!(b.get(i), Some(b'1'..=b'8'))
            && digits(i + 1, 6)
            && !b.get(i + 7).is_some_and(u8::is_ascii_digit)
    })
}
