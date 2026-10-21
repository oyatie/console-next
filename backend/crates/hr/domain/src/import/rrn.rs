//! 주민등록번호 (RRN) value detection for import cells, headers, file and
//! sheet names (moved from `app/src/hr.rs`, R2-import).

use super::pii as import_pii;

/// [`contains_rrn_shaped`], plus a whole 11–12 digit number that is an RRN
/// once the leading zeros Excel strips from a 2000–2009 birth year are
/// restored ([`import_pii::is_stripped_zero_rrn`]). Header names, the name
/// cell, the file name and sheet names are checked with this too. Migration
/// 0247 backfilled `contains_rrn_shaped`; migration 0249 backfills the rest.
pub fn is_rrn_value(text: &str) -> bool {
    contains_rrn_shaped(text) || import_pii::is_stripped_zero_rrn(text)
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
