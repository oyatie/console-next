//! Pure import PII rules (PII-2). std only, so this file is also tested on its
//! own with `rustc --test`. Migration 0249 scrubs stored values with the same
//! rules; keep the two in step.

/// A whole 11–12 digit number (optionally `.0`) that becomes a resident
/// registration number once the leading zeros Excel strips from a 2000–2009
/// birth year are put back: `YYMMDD` must be a real date in 2000–2009 and the
/// gender digit one of that century's (3/4 citizen, 7/8 foreign resident).
/// Anything else (a long numeric employee number, a 1900s gender digit) is kept.
pub fn is_stripped_zero_rrn(text: &str) -> bool {
    let whole = text.strip_suffix(".0").unwrap_or(text);
    if !matches!(whole.len(), 11 | 12)
        || whole.starts_with('0')
        || !whole.bytes().all(|b| b.is_ascii_digit())
    {
        return false;
    }
    let padded = format!("{whole:0>13}");
    let d = padded.as_bytes();
    let num = |at: usize| u32::from(d[at] - b'0') * 10 + u32::from(d[at + 1] - b'0');
    let (year, month, day) = (2000 + num(0), num(2), num(4));
    matches!(d[6], b'3' | b'4' | b'7' | b'8')
        && (1..=12).contains(&month)
        && (1..=days_in_month(year, month)).contains(&day)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

pub fn normalize_header_label(raw: &str) -> String {
    raw.chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
}

pub fn import_header_match_key(header: &str) -> String {
    normalize_header_label(header)
        .chars()
        .filter(|ch| {
            !matches!(
                ch,
                '(' | ')' | '[' | ']' | '{' | '}' | '_' | '-' | '/' | '\\' | '.' | '·' | ':'
            )
        })
        .collect::<String>()
        .to_ascii_lowercase()
}

/// English restricted header fragments, matched case-insensitively. No
/// canonical import alias contains one, so matching the key alone stays the
/// rule (0249 mirrors it with `lower(key)`).
const ENGLISH_RESTRICTED: [&str; 8] = [
    "ssn", "rrn", "phone", "mobile", "salary", "wage", "account", "bank",
];

const WORK_LOCATION_EN: [&str; 3] = ["worksite", "workplace", "site"];
const KO_PII2: (&str, &str, [&str; 4]) = ("주소", "생년월일", ["근무지", "현장", "사업장", "회사"]);

/// Restricted headers added in PII-2 to both the employee and the attendance
/// list: the English fragments, the Korean "date of birth" header, and a bare
/// Korean "address" header (a home address; a work address is always
/// qualified, e.g. "work location address").
pub fn is_pii2_restricted_header(header: &str) -> bool {
    let lower = header.to_lowercase();
    let match_key = import_header_match_key(header);
    let (ko_addr, ko_dob, ko_work) = KO_PII2;
    let has_work_qualifier = ko_work.iter().any(|q| match_key.contains(q))
        || WORK_LOCATION_EN.iter().any(|q| match_key.contains(q));
    let restricted_addr = match_key == ko_addr
        || ((header.contains(ko_addr) || match_key.contains(ko_addr)) && !has_work_qualifier);
    restricted_addr
        || header.contains(ko_dob)
        || match_key.contains(ko_dob)
        || ENGLISH_RESTRICTED
            .iter()
            .any(|fragment| lower.contains(fragment) || match_key.contains(fragment))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stripped_zero_rrn_needs_a_2000s_birth_date_and_gender_digit() {
        for hit in [
            // 010101-3456789
            "101013456789",
            "101013456789.0",
            // 001101-3412346 (two zeros stripped)
            "11013412346",
            // 040229-3123456 (2004 is a leap year)
            "402293123456",
            // 091231-8123456 (foreign resident)
            "912318123456",
        ] {
            assert!(is_stripped_zero_rrn(hit), "{hit} must match");
        }
        for miss in [
            // 001010-1345678: a 1900s gender digit
            "10101345678",
            // 090101-1234567: same
            "901011234567",
            // 000000-1000041: month 23
            "123456123456",
            // 010229-3123456: 2001 is not a leap year
            "102293123456",
            // 010431-3123456: April has 30 days
            "104313123456",
            // 010100-3123456: day 0
            "101003123456",
            "2024000123",
            "01012345678",
            "1010134567890",
            "10101-3456789",
            "",
        ] {
            assert!(!is_stripped_zero_rrn(miss), "{miss} must not match");
        }
    }

    /// hr.rs `is_rrn_value` moved "10101345678" from must-match to must-not.
    /// Before PII-2 any padded `\d{6}[1-8]\d{6}` matched; now the restored
    /// RRN must be a 2000s one.
    #[test]
    fn ten_one_zero_one_345678_is_a_1900s_gender_digit_not_a_stripped_rrn() {
        // Padded to 13: 001010 is a real date (2000-10-10), but gender digit 1
        // is a 1900s birth, and Excel only strips the zeros of 2000-2009 years.
        let padded = format!("{:0>13}", "10101345678");
        assert_eq!(padded, "0010101345678");
        assert_eq!((&padded[..6], &padded[6..7]), ("001010", "1"));
        assert!(!is_stripped_zero_rrn("10101345678"));
        // The same date with gender digit 3 (001010-3345678) is one.
        assert!(is_stripped_zero_rrn("10103345678"));
        // hr.rs's new 11-digit hit: 001101-3412346.
        let padded = format!("{:0>13}", "11013412346");
        assert_eq!((&padded[..6], &padded[6..7]), ("001101", "3"));
        assert!(is_stripped_zero_rrn("11013412346"));
    }

    #[test]
    fn pii2_headers_are_restricted_and_canonical_aliases_are_not() {
        for hit in [
            "SSN",
            "employee_ssn",
            "RRN",
            "Phone",
            "MobilePhone",
            "mobile",
            "BaseSalary",
            "hourly_wage",
            "BankAccount",
            "account_no",
            "bank",
            "생년월일",
            "직원생년월일",
            "주소",
        ] {
            assert!(is_pii2_restricted_header(hit), "{hit} must be restricted");
        }
        for miss in [
            "근무지주소",
            "근무지(주소)",
            "employee_number",
            "employee_name",
            "worksite_address",
            "workplace_name",
            "leave_balance",
            "branch_name",
            "check_in",
            "성명",
            "비고",
        ] {
            assert!(
                !is_pii2_restricted_header(miss),
                "{miss} must not be restricted"
            );
        }
        let ko = |cps: &[u32]| -> String {
            cps.iter()
                .map(|&c| char::from_u32(c).unwrap())
                .collect::<String>()
        };
        for hit in [
            ko(&[0x5B, 0xC8FC, 0xC18C, 0x5D]),
            ko(&[0xC8FC, 0xC18C, 0x28, 0xAC1C, 0xC778, 0x29]),
            ko(&[0xAC1C, 0xC778, 0x5F, 0xC8FC, 0xC18C]),
            ko(&[0xAC70, 0xC8FC, 0x5F, 0xC8FC, 0xC18C]),
            ko(&[0xAC1C, 0xC778, 0x2D, 0xC8FC, 0xC18C]),
            ko(&[0xC790, 0xD0DD, 0xC8FC, 0xC18C]),
            ko(&[0xC0DD, 0xB144, 0x5F, 0xC6D4, 0xC77C]),
            "s_s_n".to_owned(),
            "b-a-n-k".to_owned(),
        ] {
            assert!(is_pii2_restricted_header(&hit), "{hit} must be restricted");
        }
        for miss in [
            ko(&[0xD604, 0xC7A5, 0xC8FC, 0xC18C]),
            ko(&[0xC0AC, 0xC5C5, 0xC7A5, 0xC8FC, 0xC18C]),
            ko(&[0xD68C, 0xC0AC, 0xC8FC, 0xC18C]),
            ko(&[0xADFC, 0xBB34, 0xC9C0, 0x5F, 0xC8FC, 0xC18C]),
        ] {
            assert!(
                !is_pii2_restricted_header(&miss),
                "{miss} must not be restricted"
            );
        }
    }
}
