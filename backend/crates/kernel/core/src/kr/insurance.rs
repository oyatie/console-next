//! 4대보험 사업장관리번호 (국민연금 · 건강보험 · 고용보험 · 산재보험).

use super::{canonical_serde, digits_only, refusal};
use crate::KernelError;

/// An insurer-issued 사업장관리번호, stored as digits.
///
/// no primary source defines the per-insurer format (`law.md` §6),
/// so this checks digits and a length band only. Tighten per insurer when a
/// 공단 publishes the format; the band is a validation rule, not a setting.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct InsuranceMgmtNo(String);

impl InsuranceMgmtNo {
    pub const CODE_INVALID: &'static str = "insurance_mgmt_no_invalid";
    const LEN: std::ops::RangeInclusive<usize> = 8..=13;

    /// # Errors
    /// `insurance_mgmt_no_invalid` unless 8–13 digits.
    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        let digits = digits_only(raw, Self::CODE_INVALID)?;
        if !Self::LEN.contains(&digits.len()) {
            return Err(refusal(Self::CODE_INVALID));
        }
        Ok(Self(digits))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Grouped by 4 for reading aloud; no official mask exists.
    #[must_use]
    pub fn display(&self) -> String {
        let bytes: Vec<&str> = self
            .0
            .as_bytes()
            .chunks(4)
            .filter_map(|c| std::str::from_utf8(c).ok())
            .collect();
        bytes.join(" ")
    }

    /// True when the first 10 digits equal `brn` — a common pattern, shown as
    /// a soft match chip only, never enforced (unverified).
    #[must_use]
    pub fn starts_with_brn(&self, brn: &super::BizRegNo) -> bool {
        self.0.starts_with(brn.as_str())
    }
}
canonical_serde!(InsuranceMgmtNo);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_and_digits() {
        assert_eq!(
            InsuranceMgmtNo::parse("1234-5678-901").unwrap().as_str(),
            "12345678901"
        );
        assert!(InsuranceMgmtNo::parse("1234567").is_err());
        assert!(InsuranceMgmtNo::parse("12345678901234").is_err());
        assert!(InsuranceMgmtNo::parse("12345678A").is_err());
        assert_eq!(
            InsuranceMgmtNo::parse("12345678901").unwrap().display(),
            "1234 5678 901"
        );
    }

    #[test]
    fn brn_prefix_match_is_a_prefix_test() {
        let brn = crate::kr::BizRegNo::parse("000-81-00009").unwrap();
        assert!(
            InsuranceMgmtNo::parse("00081000090")
                .unwrap()
                .starts_with_brn(&brn)
        );
        assert!(
            !InsuranceMgmtNo::parse("10008100009")
                .unwrap()
                .starts_with_brn(&brn)
        );
    }
}
