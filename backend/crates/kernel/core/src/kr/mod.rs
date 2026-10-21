//! Korean registry identifiers and contact value objects (owner rule: typed,
//! stored canonical, displayed through a mask).
//!
//! Every identifier is stored as digits only and parsed from what a person
//! types or pastes: spaces, hyphens and full-width digits are accepted. A parse
//! failure is a refusal (wrong length, not digits). A failed check digit is
//! never a refusal: no primary source defines the 사업자등록번호 check digit,
//! and 법인등록번호 issued from 2025-01-31 carry none, so the authoritative
//! check is the 국세청 / 등기 record, not arithmetic here.
//!
//! Pure: no I/O, std + serde only. Refusal codes are stable snake_case, the
//! same strings the REST error envelope carries in `errors[].code`.

mod brn;
mod contact;
mod crn;
mod insurance;
mod phone;
pub mod synthetic;

pub use brn::{BizRegNo, SubWorkplaceSerial};
pub use contact::Email;
pub use crn::{CRN_CHECK_DIGIT_RETIRED_ON, CorpRegNo};
pub use insurance::InsuranceMgmtNo;
pub use phone::PhoneE164;

use crate::KernelError;

/// Digits of `raw` with separators removed and full-width digits folded.
/// Refuses any other character (`code` names the identifier).
pub(crate) fn digits_only(raw: &str, code: &'static str) -> Result<String, KernelError> {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '0'..='9' => out.push(ch),
            // Full-width ０-９ (U+FF10..U+FF19), common in pasted Korean text.
            '\u{FF10}'..='\u{FF19}' => {
                let offset = u32::from(ch) - 0xFF10;
                out.push(char::from_digit(offset, 10).unwrap_or('0'));
            }
            ' ' | '-' | '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{FF0D}' | '\t' => {}
            _ => return Err(refusal(code)),
        }
    }
    Ok(out)
}

pub(crate) fn refusal(code: &'static str) -> KernelError {
    KernelError::validation(code).with_code(code)
}

pub(crate) fn digit(s: &str, i: usize) -> u32 {
    s.as_bytes()
        .get(i)
        .map_or(0, |b| u32::from(b.saturating_sub(b'0')))
}

/// Serde for canonical-string newtypes: serialize the canonical digits,
/// deserialize through `parse` (so a stored or sent value is always valid).
macro_rules! canonical_serde {
    ($ty:ty) => {
        impl serde::Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }
        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let raw = String::deserialize(d)?;
                <$ty>::parse(&raw).map_err(|e| serde::de::Error::custom(e.message))
            }
        }
        impl std::fmt::Display for $ty {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.display())
            }
        }
    };
}
pub(crate) use canonical_serde;
