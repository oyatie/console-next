// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use console_hr_domain::import::rrn::is_rrn_value;
use console_hr_domain::import::rrn_value::Rrn;

#[test]
fn every_accepted_rrn_spelling_is_restricted() {
    for birth in ["900101", "050101", "001001"] {
        for gender in 1..=8 {
            let digits = format!("{birth}{gender}234567");
            let mut spellings = vec![digits.clone()];
            for at in 0..=digits.len() {
                spellings.push(format!("{}-{}", &digits[..at], &digits[at..]));
            }
            if matches!(gender, 3 | 4 | 7 | 8) && birth.starts_with('0') {
                spellings.push(digits.trim_start_matches('0').into());
            }
            for spelling in spellings {
                for suffix in ["", ".0"] {
                    for whitespace in ["", " \t", "\r\n", "\u{b}", "\u{a0}"] {
                        let cell = format!("{whitespace}{spelling}{suffix}{whitespace}");
                        assert_eq!(Rrn::parse(&cell).unwrap().digits(), digits);
                        assert!(is_rrn_value(&cell));
                    }
                }
            }
        }
    }
}
