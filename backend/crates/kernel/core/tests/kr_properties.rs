//! Property tests for the Korean registry identifiers and phone numbers
//! (`kernel::kr`). Default 256 cases per property; the nightly `fuzz` nextest
//! profile raises `PROPTEST_CASES` (see `.config/nextest.toml`).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::kr::{
    BizRegNo, CRN_CHECK_DIGIT_RETIRED_ON, CorpRegNo, InsuranceMgmtNo, PhoneE164, SubWorkplaceSerial,
};
use proptest::prelude::*;

/// Separators `digits_only` folds away.
const SEPARATORS: [char; 8] = [
    ' ', '-', '\u{2010}', '\u{2011}', '\u{2012}', '\u{2013}', '\u{FF0D}', '\t',
];

/// `digits` with a random separator run before each digit and some digits
/// written full-width, as pasted from a Korean document.
fn noisy(digits: &str) -> impl Strategy<Value = String> + use<> {
    let n = digits.len();
    let digits = digits.to_owned();
    (
        prop::collection::vec(
            prop::collection::vec(prop::sample::select(&SEPARATORS[..]), 0..3),
            n,
        ),
        prop::collection::vec(any::<bool>(), n),
    )
        .prop_map(move |(seps, wide)| {
            let mut out = String::new();
            for ((ch, sep), wide) in digits.chars().zip(seps).zip(wide) {
                out.extend(sep);
                out.push(if wide {
                    char::from_u32(0xFF10 + ch.to_digit(10).unwrap_or(0)).unwrap_or(ch)
                } else {
                    ch
                });
            }
            out
        })
}

fn digit_string(len: usize) -> impl Strategy<Value = String> {
    prop::collection::vec(0u8..10, len)
        .prop_map(|d| d.into_iter().map(|x| char::from(b'0' + x)).collect())
}

fn non_zero_digits(len: usize) -> impl Strategy<Value = String> {
    digit_string(len).prop_filter("all zeros is refused", |s| s.bytes().any(|b| b != b'0'))
}

proptest! {
    // ---- 사업자등록번호 ----------------------------------------------------

    #[test]
    fn brn_canonical_display_and_noise_all_parse_to_the_same_value(
        (digits, raw) in non_zero_digits(10).prop_flat_map(|d| (Just(d.clone()), noisy(&d)))
    ) {
        let brn = BizRegNo::parse(&digits).unwrap();
        prop_assert_eq!(brn.as_str(), digits.as_str());
        prop_assert_eq!(&BizRegNo::parse(&brn.display()).unwrap(), &brn);
        prop_assert_eq!(&BizRegNo::parse(&raw).unwrap(), &brn);
        let wire = serde_json::to_string(&brn).unwrap();
        prop_assert_eq!(serde_json::from_str::<BizRegNo>(&wire).unwrap(), brn);
    }

    #[test]
    fn brn_display_is_the_3_2_5_mask(digits in non_zero_digits(10)) {
        let shown = BizRegNo::parse(&digits).unwrap().display();
        prop_assert_eq!(shown, format!("{}-{}-{}", &digits[..3], &digits[3..5], &digits[5..]));
    }

    #[test]
    fn brn_has_exactly_one_check_digit_per_prefix(prefix in non_zero_digits(9)) {
        let matching = (0..10)
            .map(|d| BizRegNo::parse(&format!("{prefix}{d}")).unwrap())
            .filter(BizRegNo::checksum_matches)
            .count();
        prop_assert_eq!(matching, 1);
    }

    #[test]
    fn brn_checksum_is_a_warning_never_a_refusal(digits in non_zero_digits(10)) {
        let brn = BizRegNo::parse(&digits).unwrap();
        prop_assert_eq!(brn.warnings().is_empty(), brn.checksum_matches());
    }

    #[test]
    fn brn_refuses_every_other_length(
        digits in (0usize..20).prop_filter("10 is valid", |l| *l != 10).prop_flat_map(digit_string)
    ) {
        let err = BizRegNo::parse(&digits).unwrap_err();
        prop_assert_eq!(err.code, Some(BizRegNo::CODE_INVALID));
    }

    #[test]
    fn arbitrary_text_never_panics_and_ok_means_canonical_digits(raw in ".{0,40}") {
        if let Ok(brn) = BizRegNo::parse(&raw) {
            prop_assert!(brn.as_str().len() == 10 && brn.as_str().bytes().all(|b| b.is_ascii_digit()));
        }
        if let Ok(crn) = CorpRegNo::parse(&raw) {
            prop_assert!(crn.as_str().len() == 13 && crn.as_str().bytes().all(|b| b.is_ascii_digit()));
        }
        if let Ok(serial) = SubWorkplaceSerial::parse(&raw) {
            prop_assert!(serial.as_str().len() == 4 && serial.as_str() != "0000");
        }
        if let Ok(no) = InsuranceMgmtNo::parse(&raw) {
            prop_assert!((8..=13).contains(&no.as_str().len()));
        }
        if let Ok(phone) = PhoneE164::parse(&raw) {
            prop_assert_eq!(&PhoneE164::parse(phone.as_str()).unwrap(), &phone);
        }
    }

    // ---- 법인등록번호 ------------------------------------------------------

    #[test]
    fn crn_canonical_display_and_noise_all_parse_to_the_same_value(
        (digits, raw) in non_zero_digits(13).prop_flat_map(|d| (Just(d.clone()), noisy(&d)))
    ) {
        let crn = CorpRegNo::parse(&digits).unwrap();
        prop_assert_eq!(crn.display(), format!("{}-{}", &digits[..6], &digits[6..]));
        prop_assert_eq!(&CorpRegNo::parse(&crn.display()).unwrap(), &crn);
        prop_assert_eq!(&CorpRegNo::parse(&raw).unwrap(), &crn);
        prop_assert_eq!(crn.registry_office_code(), &digits[..4]);
        prop_assert_eq!(crn.corp_kind_code(), &digits[4..6]);
        let wire = serde_json::to_string(&crn).unwrap();
        prop_assert_eq!(serde_json::from_str::<CorpRegNo>(&wire).unwrap(), crn);
    }

    #[test]
    fn crn_has_exactly_one_check_digit_per_prefix(prefix in non_zero_digits(12)) {
        let matching = (0..10)
            .map(|d| CorpRegNo::parse(&format!("{prefix}{d}")).unwrap())
            .filter(CorpRegNo::checksum_matches)
            .count();
        prop_assert_eq!(matching, 1);
    }

    #[test]
    fn crn_warns_only_for_a_pre_2025_법인_with_a_bad_check_digit(
        digits in non_zero_digits(13),
        days in -40_000i64..2_000,
        known in any::<bool>(),
    ) {
        let crn = CorpRegNo::parse(&digits).unwrap();
        let date = CRN_CHECK_DIGIT_RETIRED_ON + time::Duration::days(days);
        let incorporated = known.then_some(date);
        let warned = !crn.warnings(incorporated).is_empty();
        prop_assert_eq!(warned, known && date < CRN_CHECK_DIGIT_RETIRED_ON && !crn.checksum_matches());
    }

    // ---- 종사업장 일련번호 · 사업장관리번호 ----------------------------------

    #[test]
    fn sub_serial_round_trips_and_keeps_leading_zeros(n in 1u16..10_000) {
        let raw = format!("{n:04}");
        let serial = SubWorkplaceSerial::parse(&raw).unwrap();
        prop_assert_eq!(serial.as_str(), raw.as_str());
        prop_assert_eq!(SubWorkplaceSerial::parse(&serial.display()).unwrap(), serial);
    }

    #[test]
    fn insurance_no_display_reparses((digits, raw) in (8usize..=13).prop_flat_map(digit_string).prop_flat_map(|d| (Just(d.clone()), noisy(&d)))) {
        let no = InsuranceMgmtNo::parse(&digits).unwrap();
        prop_assert_eq!(&InsuranceMgmtNo::parse(&no.display()).unwrap(), &no);
        prop_assert_eq!(&InsuranceMgmtNo::parse(&raw).unwrap(), &no);
    }

    // ---- 전화번호 ----------------------------------------------------------

    /// Any Korean domestic number (0 + area/mobile prefix + subscriber)
    /// stores as +82 without the trunk 0 and its display parses back.
    #[test]
    fn domestic_phone_stores_e164_and_display_round_trips(
        national in "[1-9][0-9]{6,10}",
        sep in prop::sample::select(vec!["", "-", " ", "."]),
    ) {
        let raw = format!("0{}{sep}{}", &national[..2], &national[2..]);
        let phone = PhoneE164::parse(&raw).unwrap();
        prop_assert_eq!(phone.as_str(), format!("+82{national}"));
        prop_assert_eq!(&PhoneE164::parse(&phone.display()).unwrap(), &phone);
        prop_assert_eq!(&PhoneE164::parse(&format!("+82 {national}")).unwrap(), &phone);
        prop_assert_eq!(&PhoneE164::parse(&format!("+82 (0){national}")).unwrap(), &phone);
    }

    #[test]
    fn international_phone_is_kept_verbatim(cc in "[13-79][0-9]{0,2}", rest in "[0-9]{7,11}") {
        let e164 = format!("+{cc}{rest}");
        prop_assume!((8..=15).contains(&(e164.len() - 1)));
        let phone = PhoneE164::parse(&e164).unwrap();
        prop_assert_eq!(phone.as_str(), e164.as_str());
        prop_assert_eq!(&PhoneE164::parse(&phone.display()).unwrap(), &phone);
    }

    /// A letter typed for a digit (`O1O-…`, `010-1234-567l`) or an extension
    /// note must be refused, never silently dropped into a different number.
    #[test]
    fn phone_with_a_letter_is_refused(
        national in "1[0-9]{8,9}",
        at in any::<prop::sample::Index>(),
        letter in "[A-Za-z가-힣]",
    ) {
        let mut raw = format!("0{national}");
        raw.insert_str(at.index(raw.len() + 1), &letter);
        prop_assert!(PhoneE164::parse(&raw).is_err(), "{raw:?} must be refused");
    }
}
