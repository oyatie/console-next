//! 사업자등록번호 and the 4-digit 종사업장 일련번호.

use super::{canonical_serde, digit, digits_only, refusal};
use crate::KernelError;

/// 사업자등록번호: exactly 10 digits, displayed `###-##-#####`.
///
/// The weighted check digit (1,3,7,1,3,7,1,3,5) is in wide use but has no
/// primary source, so a mismatch is a warning ([`BizRegNo::warnings`]), never
/// a refusal. The 국세청 진위확인 is authoritative.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BizRegNo(String);

impl BizRegNo {
    pub const CODE_INVALID: &'static str = "brn_invalid";
    pub const WARN_CHECKSUM: &'static str = "brn_checksum_mismatch";

    /// # Errors
    /// `brn_invalid` unless the input is exactly 10 digits (separators
    /// allowed) and not all zeros.
    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        let digits = digits_only(raw, Self::CODE_INVALID)?;
        if digits.len() != 10 || digits.bytes().all(|b| b == b'0') {
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
        format!("{}-{}-{}", &self.0[..3], &self.0[3..5], &self.0[5..])
    }

    /// The common weighted checksum. `false` is a soft signal only.
    #[must_use]
    pub fn checksum_matches(&self) -> bool {
        const W: [u32; 9] = [1, 3, 7, 1, 3, 7, 1, 3, 5];
        let s = &self.0;
        let mut sum: u32 = (0..9).map(|i| digit(s, i) * W[i]).sum();
        sum += digit(s, 8) * 5 / 10;
        (10 - sum % 10) % 10 == digit(s, 9)
    }

    /// Soft warning codes (never refusals).
    #[must_use]
    pub fn warnings(&self) -> Vec<&'static str> {
        if self.checksum_matches() {
            Vec::new()
        } else {
            vec![Self::WARN_CHECKSUM]
        }
    }
}
canonical_serde!(BizRegNo);

/// 종사업장 일련번호 (사업자단위과세 부표 ①): 4 digits, never `0000`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SubWorkplaceSerial(String);

impl SubWorkplaceSerial {
    pub const CODE_INVALID: &'static str = "sub_serial_invalid";

    /// # Errors
    /// `sub_serial_invalid` unless exactly 4 digits other than `0000`.
    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        let digits = digits_only(raw, Self::CODE_INVALID)?;
        if digits.len() != 4 || digits == "0000" {
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
        self.0.clone()
    }
}
canonical_serde!(SubWorkplaceSerial);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_formatted_unformatted_and_full_width() {
        let a = BizRegNo::parse("000-81-00009").unwrap();
        let b = BizRegNo::parse("0008100009").unwrap();
        let c = BizRegNo::parse("０００ ８１ ００００９").unwrap();
        assert_eq!(a, b);
        assert_eq!(b, c);
        assert_eq!(a.as_str(), "0008100009");
        assert_eq!(a.display(), "000-81-00009");
    }

    #[test]
    fn refuses_wrong_length_letters_and_zeros() {
        for bad in [
            "000-81-0000",
            "00081000091",
            "000-8I-00009",
            "0000000000",
            "",
        ] {
            let err = BizRegNo::parse(bad).unwrap_err();
            assert_eq!(err.code, Some(BizRegNo::CODE_INVALID), "{bad}");
        }
    }

    #[test]
    fn checksum_is_a_warning_not_a_refusal() {
        // Synthetic numbers (000 = no such tax office) that satisfy the common checksum.
        assert!(
            BizRegNo::parse("000-81-00009")
                .unwrap()
                .warnings()
                .is_empty()
        );
        assert!(
            BizRegNo::parse("000-86-00019")
                .unwrap()
                .warnings()
                .is_empty()
        );
        let off = BizRegNo::parse("000-81-00994").unwrap();
        assert_eq!(off.warnings(), vec![BizRegNo::WARN_CHECKSUM]);
    }

    #[test]
    fn serde_round_trips_canonical_and_refuses_bad_input() {
        let brn: BizRegNo = serde_json::from_str("\"000-81-00009\"").unwrap();
        assert_eq!(serde_json::to_string(&brn).unwrap(), "\"0008100009\"");
        assert!(serde_json::from_str::<BizRegNo>("\"12\"").is_err());
    }

    #[test]
    fn sub_serial_is_four_digits_not_zero() {
        let serial = SubWorkplaceSerial::parse("00-01").unwrap();
        assert_eq!(serial.as_str(), "0001");
        assert_eq!(serial.to_string(), "0001");
        assert!(SubWorkplaceSerial::parse("0000").is_err());
        assert!(SubWorkplaceSerial::parse("123").is_err());
    }
}
