//! Resident registration number (RRN) value detection for import cells,
//! headers, file and sheet names (moved from `app/src/hr.rs`, R2-import).

use super::cells::half_width;
use super::rrn_value::Rrn;

/// Every spelling the vault accepts, plus embedded RRN shapes even when the
/// birth date is invalid. Used for cells, headers, names and stored text.
pub fn is_rrn_value(text: &str) -> bool {
    // Classify presentation variants without widening the vault's input contract.
    let normalized: String = half_width(text)
        .chars()
        .map(|c| match c {
            '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{fe63}' | '\u{ff0d}' => '-',
            c if c.is_whitespace() => ' ',
            _ => c,
        })
        .collect();
    // Keep boundaries between neighboring numbers when scanning embedded values.
    contains_rrn_shaped(&normalized) || Rrn::parse(&normalized.replace(' ', "")).is_ok()
}

/// Thirteen digits, with optional spaces and a dash after the birth date,
/// not touching another digit. The gender digit is 1–8.
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
        while b.get(i) == Some(&b' ') {
            i += 1;
        }
        if b.get(i) == Some(&b'-') {
            i += 1;
        }
        while b.get(i) == Some(&b' ') {
            i += 1;
        }
        matches!(b.get(i), Some(b'1'..=b'8'))
            && digits(i + 1, 6)
            && !b.get(i + 7).is_some_and(u8::is_ascii_digit)
    })
}
