//! Text and date normalisers shared by every HR subdomain (moved from
//! `app/src/hr.rs`, R2-exits). Refusals are `KernelError::validation`; the
//! adapter maps them through `From<KernelError> for HrError` unchanged.

use console_kernel_core::KernelError;
use time::{Date, Month};

pub fn normalize_enum_text(value: String) -> String {
    value.trim().to_ascii_uppercase()
}

pub fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub fn normalize_date_text(value: &str) -> Result<String, KernelError> {
    Ok(parse_yyyy_mm_dd(value)?.to_string())
}

pub fn parse_yyyy_mm_dd(value: &str) -> Result<Date, KernelError> {
    let value = value.trim();
    let parts = value.split('-').collect::<Vec<_>>();
    // All digits: `str::parse` alone takes a sign, so "+000-+1-+1" read as 0000-01-01.
    if parts.len() != 3
        || parts[0].len() != 4
        || parts[1].len() != 2
        || parts[2].len() != 2
        || !parts
            .iter()
            .all(|part| part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(KernelError::validation("date must use YYYY-MM-DD"));
    }
    let year = parts[0]
        .parse::<i32>()
        .map_err(|_| KernelError::validation("date year must be numeric"))?;
    let month = parts[1]
        .parse::<u8>()
        .map_err(|_| KernelError::validation("date month must be numeric"))?;
    let day = parts[2]
        .parse::<u8>()
        .map_err(|_| KernelError::validation("date day must be numeric"))?;
    let month =
        Month::try_from(month).map_err(|_| KernelError::validation("date month is invalid"))?;
    Date::from_calendar_date(year, month, day)
        .map_err(|_| KernelError::validation("date day is invalid"))
}

pub fn normalize_limited_text(
    value: String,
    max_chars: usize,
    field: &'static str,
) -> Result<String, KernelError> {
    let value = normalize_optional_text(Some(value))
        .ok_or_else(|| KernelError::validation(format!("{field} is required")))?;
    if value.chars().count() > max_chars {
        return Err(KernelError::validation(format!(
            "{field} must be {max_chars} characters or fewer"
        )));
    }
    Ok(value)
}

pub fn normalize_optional_limited_text(
    value: Option<String>,
    max_chars: usize,
    field: &'static str,
) -> Result<Option<String>, KernelError> {
    match normalize_optional_text(value) {
        Some(value) if value.chars().count() > max_chars => Err(KernelError::validation(format!(
            "{field} must be {max_chars} characters or fewer"
        ))),
        value => Ok(value),
    }
}
