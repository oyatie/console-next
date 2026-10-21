//! 근로자 명부 items held by HR itself (MR-23): 성별, 이력 · 경력, the 퇴직
//! 사유 label, 그 밖에 필요한 사항. 근로기준법 §41①, 시행령 §20 2·5·8·9호,
//! 시행규칙 §16 별지 제16호서식 (law.go.kr MST 290781 / 270551 / 269393).
//! The 주소 shape is the entity context's `KrAddress`, validated by the adapter.
//!
//! Pure: values in, typed values or a coded `KernelError` out.

use console_kernel_core::KernelError;
use serde::{Deserialize, Serialize};
use time::{Date, Month};

mod labels;

pub use labels::{CAREER_NONE, exit_reason_label, sex_label};

/// The correction fields this module owns (`employee_corrections.field`).
pub const REGISTER_FIELDS: [&str; 5] =
    ["sex", "address", "careers", "exit_reason", "register_note"];

/// Most career rows one employee holds (the `seq` CHECK bound).
pub const MAX_CAREER_ROWS: usize = 100;

const NOTE_MAX_CHARS: usize = 500;

/// 성별 (영 §20 2호), as 별지 제16호서식 records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sex {
    Male,
    Female,
}

impl Sex {
    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "MALE" => Ok(Self::Male),
            "FEMALE" => Ok(Self::Female),
            _ => Err(KernelError::validation("sex must be MALE or FEMALE").with_field("sex")),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Male => "MALE",
            Self::Female => "FEMALE",
        }
    }
}

/// One 경력 row as the client sends it; months are `YYYY-MM`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CareerInput {
    pub employer_name: String,
    pub from: String,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub position: Option<String>,
    #[serde(default)]
    pub duty: Option<String>,
    #[serde(default)]
    pub leave_reason: Option<String>,
}

/// A checked 경력 row; months are the first day of the month.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Career {
    pub employer_name: String,
    #[serde(serialize_with = "month_text")]
    pub from: Date,
    #[serde(serialize_with = "optional_month_text")]
    pub to: Option<Date>,
    pub position: Option<String>,
    pub duty: Option<String>,
    pub leave_reason: Option<String>,
}

fn month_text<S: serde::Serializer>(date: &Date, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format_month(*date))
}

fn optional_month_text<S: serde::Serializer>(date: &Option<Date>, s: S) -> Result<S::Ok, S::Error> {
    match date {
        Some(date) => month_text(date, s),
        None => s.serialize_none(),
    }
}

/// `YYYY-MM` of a month's first day.
#[must_use]
pub fn format_month(date: Date) -> String {
    format!("{:04}-{:02}", date.year(), u8::from(date.month()))
}

/// `YYYY-MM` → the first day of that month.
pub fn parse_month(raw: &str, field: &str) -> Result<Date, KernelError> {
    let invalid = || KernelError::validation("career months must use YYYY-MM").with_field(field);
    let (year, month) = raw.trim().split_once('-').ok_or_else(invalid)?;
    if year.len() != 4 || month.len() != 2 {
        return Err(invalid());
    }
    let year: i32 = year.parse().map_err(|_| invalid())?;
    let month: u8 = month.parse().map_err(|_| invalid())?;
    let month = Month::try_from(month).map_err(|_| invalid())?;
    if year < 1900 {
        return Err(invalid());
    }
    Date::from_calendar_date(year, month, 1).map_err(|_| invalid())
}

fn bounded(value: Option<String>, max: usize, field: &str) -> Result<Option<String>, KernelError> {
    let value = value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if value.as_ref().is_some_and(|v| v.chars().count() > max) {
        return Err(
            KernelError::validation(format!("{field} must be {max} characters or fewer"))
                .with_field(field),
        );
    }
    Ok(value)
}

/// Checks the whole 경력 list (an empty list is 「경력 없음」).
pub fn validate_careers(rows: Vec<CareerInput>) -> Result<Vec<Career>, KernelError> {
    if rows.len() > MAX_CAREER_ROWS {
        return Err(KernelError::validation(format!(
            "careers holds at most {MAX_CAREER_ROWS} rows"
        ))
        .with_field("careers"));
    }
    rows.into_iter()
        .enumerate()
        .map(|(index, row)| {
            let at = |name: &str| format!("careers[{index}].{name}");
            let employer_name = bounded(Some(row.employer_name), 100, &at("employer_name"))?
                .ok_or_else(|| {
                    KernelError::validation("employer_name is required")
                        .with_field(at("employer_name"))
                })?;
            let from = parse_month(&row.from, &at("from"))?;
            let to = row
                .to
                .filter(|to| !to.trim().is_empty())
                .map(|to| parse_month(&to, &at("to")))
                .transpose()?;
            if to.is_some_and(|to| to < from) {
                return Err(
                    KernelError::validation("to must not be before from").with_field(at("to"))
                );
            }
            Ok(Career {
                employer_name,
                from,
                to,
                position: bounded(row.position, 100, &at("position"))?,
                duty: bounded(row.duty, 200, &at("duty"))?,
                leave_reason: bounded(row.leave_reason, 200, &at("leave_reason"))?,
            })
        })
        .collect()
}

/// 그 밖에 필요한 사항: optional, trimmed, at most 500 characters.
pub fn normalize_register_note(raw: &str) -> Result<Option<String>, KernelError> {
    bounded(Some(raw.to_owned()), NOTE_MAX_CHARS, "register_note")
}

#[cfg(test)]
mod tests;
