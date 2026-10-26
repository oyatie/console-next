//! 주민등록번호 as a value the import keeps (decisions #25): checked for shape
//! and a real birth date, sealed and
//! matched only through the [`RrnVault`] port (the keys live with the
//! shell, never in the database). The value never prints: `Debug` is redacted.
//!
//! Shape only, never the check digit: numbers issued since October 2020
//! have no check digit. 생년월일/성별 are not derived from it into other
//! fields (decisions #20 Q3).

use time::{Date, Month};
use uuid::Uuid;

use super::pii::is_stripped_zero_rrn;

/// A 13-digit 주민등록번호 that passed [`Rrn::parse`].
#[derive(Clone, PartialEq, Eq)]
pub struct Rrn(String);

impl std::fmt::Debug for Rrn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Rrn([redacted])")
    }
}

/// Why a cell is not a 주민등록번호 the import can keep (code `rrn_invalid`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RrnInvalid;

impl Rrn {
    /// `900101-1234567`, `9001011234567`, or a whole number Excel stripped
    /// the leading zero from (a 2000s birth year).
    ///
    /// # Errors
    /// [`RrnInvalid`] for anything else, including an impossible birth date.
    pub fn parse(text: &str) -> Result<Self, RrnInvalid> {
        let trimmed = text.trim();
        let whole = trimmed.strip_suffix(".0").unwrap_or(trimmed);
        let digits: String = if is_stripped_zero_rrn(whole) {
            format!("{whole:0>13}")
        } else {
            let (head, tail) = match whole.split_once('-') {
                Some((head, tail)) => (head, tail),
                None if whole.len() == 13 => whole.split_at(6),
                None => return Err(RrnInvalid),
            };
            format!("{head}{tail}")
        };
        let b = digits.as_bytes();
        if b.len() != 13 || !b.iter().all(u8::is_ascii_digit) {
            return Err(RrnInvalid);
        }
        let century = match b[6] {
            b'1' | b'2' | b'5' | b'6' => 1900,
            b'3' | b'4' | b'7' | b'8' => 2000,
            _ => return Err(RrnInvalid),
        };
        let two = |at: usize| i32::from(b[at] - b'0') * 10 + i32::from(b[at + 1] - b'0');
        let month = u8::try_from(two(2))
            .ok()
            .and_then(|m| Month::try_from(m).ok())
            .ok_or(RrnInvalid)?;
        let day = u8::try_from(two(4)).map_err(|_| RrnInvalid)?;
        Date::from_calendar_date(century + two(0), month, day).map_err(|_| RrnInvalid)?;
        Ok(Self(digits))
    }

    /// The 13 digits (for the vault only).
    #[must_use]
    pub fn digits(&self) -> &str {
        &self.0
    }

    /// Storage compatibility only: required by the legacy column CHECKs. Never display this value.
    #[must_use]
    pub fn masked(&self) -> String {
        format!("{}-{}******", &self.0[..6], &self.0[6..7])
    }
}

/// A sealed 주민등록번호 as stored (employee_rrn, data_import_row_identities).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedRrn {
    /// HMAC-SHA256 under the vault's matching key: the only thing compared.
    pub hmac: Vec<u8>,
    pub hmac_key_version: i16,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub dek_wrapped: Vec<u8>,
    pub dek_nonce: Vec<u8>,
    pub key_version: i16,
    pub masked: String,
}

/// The vault failed (no key, wrong key, tampered row). Carries no value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultError;

/// Seals, opens and blind-indexes a 주민등록번호. The shell implements it with
/// keys from its environment; a tenant's rows are bound to the tenant.
pub trait RrnVault: Send + Sync {
    /// # Errors
    /// [`VaultError`] when sealing fails.
    fn seal(&self, org: Uuid, rrn: &Rrn) -> Result<SealedRrn, VaultError>;

    /// The matching key of `rrn` under the current HMAC key.
    fn blind_index(&self, rrn: &Rrn) -> Vec<u8>;

    /// # Errors
    /// [`VaultError`] for a wrong key, another tenant's row or a tampered one.
    fn open(&self, org: Uuid, sealed: &SealedRrn) -> Result<Rrn, VaultError>;
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn spellings_of_one_number_parse_to_one_value() {
        let a = Rrn::parse("900101-1234567").unwrap();
        assert_eq!(Rrn::parse(" 9001011234567 ").unwrap(), a);
        assert_eq!(a.masked(), "900101-1******");
        assert!(!format!("{a:?}").chars().any(|c| c.is_ascii_digit()));
        // 2005-01-01, the leading zero stripped by Excel.
        let b = Rrn::parse("501013234567").unwrap();
        assert_eq!(b.digits(), "0501013234567");
        assert_eq!(Rrn::parse("501013234567.0").unwrap(), b);
        assert!(!format!("{a:?}").contains("234567"));
    }

    #[test]
    fn anything_else_is_invalid() {
        for bad in [
            "",
            "900101-123456",
            "900101-9234567",
            "901301-1234567",
            "900230-2234567",
            "90010112345678",
            "abcdef-1234567",
            "900101 1234567",
        ] {
            assert_eq!(Rrn::parse(bad), Err(RrnInvalid), "{bad}");
        }
    }

    #[test]
    fn property_every_valid_birth_date_and_gender_digit_round_trips() {
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        for _ in 0..2_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let gender = b"12345678"[(seed % 8) as usize];
            let year = if matches!(gender, b'1' | b'2' | b'5' | b'6') {
                1900
            } else {
                2000
            } + (seed >> 8) % 100;
            let day = Date::from_calendar_date(year as i32, Month::January, 1).unwrap()
                + time::Duration::days(((seed >> 20) % 365) as i64);
            if day.year() != year as i32 {
                continue;
            }
            let text = format!(
                "{:02}{:02}{:02}-{}{:06}",
                year % 100,
                u8::from(day.month()),
                day.day(),
                gender as char,
                (seed >> 32) % 1_000_000
            );
            let rrn = Rrn::parse(&text).unwrap();
            assert_eq!(rrn.masked(), format!("{}******", &text[..8]));
            assert_eq!(Rrn::parse(rrn.digits()).unwrap(), rrn);
        }
    }
}
