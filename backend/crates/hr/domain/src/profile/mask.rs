// SPDX-License-Identifier: LicenseRef-Proprietary
//! Display policy only. Storage masks are never display policy.

use time::Date;

const DOTS: &str = "••••";

#[must_use]
pub fn rrn() -> String {
    "••••••-•••••••".to_owned()
}

#[must_use]
pub fn birth() -> &'static str {
    "••••-••-••"
}

/// Namesake review only, independently of the ordinary birth-date display level.
#[must_use]
pub fn birth_disambiguation(date: Date) -> String {
    format!("{:04}-{:02}-••", date.year(), u8::from(date.month()))
}

#[must_use]
pub fn address(si: &str, sgg: &str) -> String {
    [si, sgg, DOTS]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[must_use]
pub fn phone(e164: &str) -> String {
    let digits: String = e164.chars().filter(char::is_ascii_digit).collect();
    let local = digits.strip_prefix("82").map(|d| format!("0{d}"));
    let d = local.as_deref().unwrap_or(&digits);
    if d.len() >= 8 {
        return format!("{}-{DOTS}-{}", &d[..3], &d[d.len() - 4..]);
    }
    DOTS.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_class_uses_its_default_policy() {
        assert_eq!(rrn(), "••••••-•••••••");
        assert!(!rrn().chars().any(|c| c.is_ascii_digit()));
        assert_eq!(birth(), "••••-••-••");
        assert_eq!(
            birth_disambiguation(time::macros::date!(1990 - 01 - 01)),
            "1990-01-••"
        );
        assert_eq!(address("경기도", "평택시"), "경기도 평택시 ••••");
        assert_eq!(address("", ""), DOTS);
        assert_eq!(phone("+821012345821"), "010-••••-5821");
        assert_eq!(phone("010-1234-5821"), "010-••••-5821");
        assert_eq!(phone("123"), DOTS);
    }
}
