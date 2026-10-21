//! Phone numbers: stored E.164, shown in Korean domestic format.

use super::{canonical_serde, refusal};
use crate::KernelError;

/// An E.164 phone number (`+8210…`). Parsing accepts Korean domestic input
/// (`010-1234-5678`, `02-123-4567`, `1588-1234`) and international `+…`.
///
/// The one phone rule: the HR register's `normalize_phone_e164`
/// (hr adapter `directory/normalize.rs`) delegates here.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PhoneE164(String);

impl PhoneE164 {
    pub const CODE_INVALID: &'static str = "phone_invalid";

    /// # Errors
    /// `phone_invalid` when the input holds anything but digits, `+` and
    /// separators (space, `-`, `.`, parentheses), or the result is not
    /// `^\+[1-9][0-9]{7,14}$`. A letter is refused rather than dropped:
    /// `O1O-…` would otherwise store as a different (+1) number.
    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        let mut compact = String::with_capacity(raw.len());
        for c in raw.chars() {
            match c {
                '0'..='9' | '+' => compact.push(c),
                '\u{FF10}'..='\u{FF19}' => {
                    compact.push(char::from_digit(u32::from(c) - 0xFF10, 10).unwrap_or('x'));
                }
                '\u{FF0B}' => compact.push('+'),
                ' '
                | '\t'
                | '\u{A0}'
                | '\u{3000}'
                | '-'
                | '.'
                | '('
                | ')'
                | '\u{2010}'..='\u{2013}'
                | '\u{FF0D}' => {}
                _ => return Err(refusal(Self::CODE_INVALID)),
            }
        }
        let phone = if let Some(local) = compact.strip_prefix("+82") {
            format!("+82{}", local.strip_prefix('0').unwrap_or(local))
        } else if let Some(intl) = compact.strip_prefix("82") {
            format!("+82{}", intl.strip_prefix('0').unwrap_or(intl))
        } else if let Some(local) = compact.strip_prefix('0') {
            format!("+82{local}")
        } else if compact.starts_with('+') {
            compact
        } else if compact.len() == 8 && matches!(compact.get(..2), Some("15" | "16" | "18")) {
            // 전국대표번호 (1588-xxxx): domestic only, stored under +82.
            format!("+82{compact}")
        } else {
            format!("+{compact}")
        };
        let digits = &phone[1.min(phone.len())..];
        let valid = phone.starts_with('+')
            && (8..=15).contains(&digits.len())
            && digits.chars().next().is_some_and(|c| c != '0')
            && digits.chars().all(|c| c.is_ascii_digit());
        if !valid {
            return Err(refusal(Self::CODE_INVALID));
        }
        Ok(Self(phone))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Korean domestic rendering for `+82` numbers; others stay E.164.
    #[must_use]
    pub fn display(&self) -> String {
        let Some(n) = self.0.strip_prefix("+82") else {
            return self.0.clone();
        };
        let split = |prefix: &str, rest: &str| -> String {
            if rest.len() < 7 {
                return format!("{prefix}-{rest}");
            }
            let (mid, last) = rest.split_at(rest.len() - 4);
            format!("{prefix}-{mid}-{last}")
        };
        if n.len() == 8 && matches!(n.get(..2), Some("15" | "16" | "18")) {
            return format!("{}-{}", &n[..4], &n[4..]);
        }
        if let Some(rest) = n.strip_prefix('2') {
            return split("02", rest);
        }
        // 050x 평생번호 use a 4-digit prefix; everything else a 3-digit one.
        let head = if n.starts_with("50") { 3 } else { 2 };
        match (n.get(..head), n.get(head..)) {
            (Some(p), Some(rest)) => split(&format!("0{p}"), rest),
            _ => self.0.clone(),
        }
    }
}
canonical_serde!(PhoneE164);

impl std::fmt::Debug for PhoneE164 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "PhoneE164({:?})",
            crate::RedactedPhone::new(self.0.clone())
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domestic_and_international_round_trip() {
        let cases = [
            ("01012340001", "+821012340001", "010-1234-0001"),
            ("010-123-0001", "+82101230001", "010-123-0001"),
            ("02-123-4567", "+8221234567", "02-123-4567"),
            ("02 1234 5678", "+82212345678", "02-1234-5678"),
            ("031-123-4567", "+82311234567", "031-123-4567"),
            ("+82 10 1234 0001", "+821012340001", "010-1234-0001"),
            ("1588-1234", "+8215881234", "1588-1234"),
            ("0505-123-4567", "+825051234567", "0505-123-4567"),
            ("０１０１２３４０００１", "+821012340001", "010-1234-0001"),
            // NBSP / ideographic space from pasted web or Korean text.
            (
                "010\u{A0}1234\u{3000}0001",
                "+821012340001",
                "010-1234-0001",
            ),
            ("+1 415 555 0100", "+14155550100", "+14155550100"),
        ];
        for (raw, e164, shown) in cases {
            let phone = PhoneE164::parse(raw).unwrap();
            assert_eq!(phone.as_str(), e164, "{raw}");
            assert_eq!(phone.display(), shown, "{raw}");
        }
    }

    #[test]
    fn refuses_junk() {
        // "1588-123": a 대표번호 typo is refused, not stored as a Korean number.
        for bad in [
            "",
            "123",
            "+0123456789",
            "010",
            "1588-123",
            // A letter for a digit used to drop out and leave +112345678.
            "O1O-1234-5678",
            "010-1234-5678 (내선 123)",
        ] {
            assert!(PhoneE164::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn debug_is_redacted() {
        let phone = PhoneE164::parse("010-1234-0001").unwrap();
        assert!(!format!("{phone:?}").contains("2345"));
    }
}
