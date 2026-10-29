// SPDX-License-Identifier: LicenseRef-Proprietary
//! Display policy only. Storage masks are never display policy.

use serde::{Deserialize, Serialize};
use time::Date;

const DOTS: &str = "••••";

/// The personal-field classes shared by masked reads and governed reveals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RevealField {
    Rrn,
    BirthDate,
    Address,
    Phone,
    PersonalEmail,
}

impl RevealField {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rrn => "RRN",
            Self::BirthDate => "BIRTH_DATE",
            Self::Address => "ADDRESS",
            Self::Phone => "PHONE",
            Self::PersonalEmail => "PERSONAL_EMAIL",
        }
    }

    /// Source aliases resolve here, rather than in each presentation's column list.
    pub fn from_column(column: &str) -> Option<Self> {
        match column {
            "rrn" => Some(Self::Rrn),
            "birth_date" => Some(Self::BirthDate),
            "address" | "address_line" => Some(Self::Address),
            "phone" | "phone_e164" => Some(Self::Phone),
            "personal_email" => Some(Self::PersonalEmail),
            _ => None,
        }
    }

    #[must_use]
    pub fn masked(self, value: &str) -> String {
        if value.is_empty() {
            return String::new();
        }
        match self {
            Self::Rrn => rrn(),
            Self::BirthDate => birth().to_owned(),
            Self::Address => address("", ""),
            Self::Phone => phone(value),
            Self::PersonalEmail => DOTS.to_owned(),
        }
    }
}

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

    #[test]
    fn classified_columns_share_reveal_types_and_preserve_absent_values() {
        for (column, field, raw, masked) in [
            ("birth_date", RevealField::BirthDate, "1990-01-01", birth()),
            (
                "phone_e164",
                RevealField::Phone,
                "+821012345821",
                "010-••••-5821",
            ),
            (
                "address_line",
                RevealField::Address,
                "서울시 주소 101호",
                DOTS,
            ),
        ] {
            assert_eq!(RevealField::from_column(column), Some(field));
            assert_eq!(field.masked(raw), masked);
            assert!(field.masked("").is_empty());
        }
        assert_eq!(RevealField::from_column("employee_number"), None);
    }
}
