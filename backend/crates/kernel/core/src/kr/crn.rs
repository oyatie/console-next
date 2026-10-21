//! 법인등록번호 (상업등기규칙 별표 / 법인등록번호 부여 규칙).

use super::{canonical_serde, digit, digits_only, refusal};
use crate::KernelError;

/// Numbers issued from this date carry no check digit (`law.md` §6): the 13th
/// digit is part of the serial, so the checksum would fail ~90% of the time.
pub const CRN_CHECK_DIGIT_RETIRED_ON: time::Date = time::macros::date!(2025 - 01 - 31);

/// 법인등록번호: exactly 13 digits, displayed `######-#######`.
///
/// Digits 1–4 are the 등기관서 code (별표 2) and 5–6 the 법인 종류 (별표 3).
/// Both lists are renumbered over time, so an unlisted code is a warning raised
/// by the caller against the loaded list, never a refusal here.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CorpRegNo(String);

impl CorpRegNo {
    pub const CODE_INVALID: &'static str = "crn_invalid";
    pub const WARN_CHECKSUM: &'static str = "crn_checksum_mismatch";

    /// # Errors
    /// `crn_invalid` unless the input is exactly 13 digits and not all zeros.
    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        let digits = digits_only(raw, Self::CODE_INVALID)?;
        if digits.len() != 13 || digits.bytes().all(|b| b == b'0') {
            return Err(refusal(Self::CODE_INVALID));
        }
        Ok(Self(digits))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn display(&self) -> String {
        format!("{}-{}", &self.0[..6], &self.0[6..])
    }

    /// 등기관서 code (digits 1–4).
    #[must_use]
    pub fn registry_office_code(&self) -> &str {
        &self.0[..4]
    }

    /// 법인 종류 code (digits 5–6).
    #[must_use]
    pub fn corp_kind_code(&self) -> &str {
        &self.0[4..6]
    }

    /// 별표 4 checksum: weights 1,2,1,2… over 12 digits.
    #[must_use]
    pub fn checksum_matches(&self) -> bool {
        let s = &self.0;
        let sum: u32 = (0..12)
            .map(|i| digit(s, i) * if i % 2 == 0 { 1 } else { 2 })
            .sum();
        (10 - sum % 10) % 10 == digit(s, 12)
    }

    /// Soft warnings. The checksum runs only for a 법인 known to be
    /// incorporated before [`CRN_CHECK_DIGIT_RETIRED_ON`]; with no date, or a
    /// later one, nothing is said (a warning on every valid new 법인 would
    /// teach users to ignore amber).
    #[must_use]
    pub fn warnings(&self, incorporated_on: Option<time::Date>) -> Vec<&'static str> {
        match incorporated_on {
            Some(date) if date < CRN_CHECK_DIGIT_RETIRED_ON && !self.checksum_matches() => {
                vec![Self::WARN_CHECKSUM]
            }
            _ => Vec::new(),
        }
    }
}
canonical_serde!(CorpRegNo);

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn parses_and_masks() {
        let crn = CorpRegNo::parse("000211-0006241").unwrap();
        assert_eq!(crn.as_str(), "0002110006241");
        assert_eq!(crn.display(), "000211-0006241");
        assert_eq!(crn.registry_office_code(), "0002");
        assert_eq!(crn.corp_kind_code(), "11");
    }

    #[test]
    fn refuses_length_only() {
        assert!(CorpRegNo::parse("000211-000624").is_err());
        assert!(CorpRegNo::parse("000211-00062466").is_err());
        assert!(CorpRegNo::parse("0000000000000").is_err());
        // Unknown office/kind codes are NOT refused here.
        assert!(CorpRegNo::parse("999999-0000001").is_ok());
    }

    #[test]
    fn checksum_gated_by_incorporation_date() {
        let good = CorpRegNo::parse("000211-0006241").unwrap();
        assert!(good.warnings(Some(date!(1969 - 01 - 13))).is_empty());
        let off = CorpRegNo::parse("000211-0006242").unwrap();
        assert_eq!(
            off.warnings(Some(date!(1969 - 01 - 13))),
            vec![CorpRegNo::WARN_CHECKSUM]
        );
        // New numbers have no check digit; unknown date says nothing.
        assert!(off.warnings(Some(date!(2025 - 02 - 03))).is_empty());
        assert!(off.warnings(None).is_empty());
        // The retirement day itself already issues numbers without a check digit.
        assert!(off.warnings(Some(CRN_CHECK_DIGIT_RETIRED_ON)).is_empty());
        assert_eq!(
            off.warnings(CRN_CHECK_DIGIT_RETIRED_ON.previous_day()),
            vec![CorpRegNo::WARN_CHECKSUM]
        );
    }

    #[test]
    fn checksum_weights_alternate_one_two() {
        // This synthetic fixture distinguishes alternating weights from weights 1,1,2,2….
        let crn = CorpRegNo::parse("000000-1000033").unwrap();
        assert!(crn.checksum_matches());
        assert!(
            !CorpRegNo::parse("000111-1234563")
                .unwrap()
                .checksum_matches()
        );
    }
}
