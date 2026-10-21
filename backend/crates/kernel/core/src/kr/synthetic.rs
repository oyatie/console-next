// SPDX-License-Identifier: LicenseRef-Proprietary
//! Synthetic registration numbers for tests and fixtures. The `000` prefix is
//! never issued, and the check digit is computed here, never typed by hand
//! (a hand-typed check digit once failed the NTS rule and blocked a release).

use super::{BizRegNo, CorpRegNo};

/// `000-{class:02}-{serial:04}{check}`: a checksum-valid 사업자등록번호 whose
/// middle code `class` keeps its NTS classification (81 corporate head office,
/// 85 corporate branch, …).
#[must_use]
pub fn brn(class: u8, serial: u16) -> String {
    let prefix = format!("000{:02}{:04}", class % 100, serial % 10_000);
    let d = with_check_digit(&prefix, |n| {
        BizRegNo::parse(n).is_ok_and(|b| b.checksum_matches())
    });
    format!("{}-{}-{}", &d[..3], &d[3..5], &d[5..])
}

/// `0002{kind:02}-{serial:06}{check}`: a checksum-valid 법인등록번호 with the
/// unissued 등기관서 code `0002` and 법인 종류 `kind` (11 주식회사).
#[must_use]
pub fn crn(kind: u8, serial: u32) -> String {
    let prefix = format!("0002{:02}{:06}", kind % 100, serial % 1_000_000);
    let d = with_check_digit(&prefix, |n| {
        CorpRegNo::parse(n).is_ok_and(|c| c.checksum_matches())
    });
    format!("{}-{}", &d[..6], &d[6..])
}

/// Exactly one digit satisfies a mod-10 check, so the fallback is unreachable.
fn with_check_digit(prefix: &str, valid: impl Fn(&str) -> bool) -> String {
    (0..=9)
        .map(|d| format!("{prefix}{d}"))
        .find(|n| valid(n))
        .unwrap_or_else(|| format!("{prefix}0"))
}

#[cfg(test)]
mod tests {
    use super::{brn, crn};
    use crate::kr::{BizRegNo, CorpRegNo};

    #[test]
    fn synthetic_numbers_are_unissued_and_checksum_valid() {
        for serial in [0, 1, 17, 9_999] {
            let b = brn(81, serial);
            assert!(b.starts_with("000-81-"), "{b}");
            assert!(BizRegNo::parse(&b).unwrap().checksum_matches(), "{b}");
        }
        // The release-blocking fixture: 000-81-0001 takes check digit 4, not 7.
        assert_eq!(brn(81, 1), "000-81-00014");
        for serial in [0, 1, 999_999] {
            let c = crn(11, serial);
            assert!(c.starts_with("000211-"), "{c}");
            assert!(CorpRegNo::parse(&c).unwrap().checksum_matches(), "{c}");
        }
    }
}
