//! The stored form of one corrected value, checked on its own (the checks
//! that need the record run in [`super::write`]). Used when a correction is
//! applied, when a PROFILE_CORRECTION is filed, and by the facts PATCH.

use console_hr_domain::corrections::catalog::kind_for_field;
use console_hr_domain::profile::enums::{EmploymentType, IdType, PayUnit};
use console_hr_domain::profile::facts::{normalize_work_email, validate_birth_date};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::KernelError;
use serde_json::Value;
use time::Date;

use crate::HrError;
use crate::clock::today_kst;
use crate::directory::normalize::{normalize_phone_e164, required_employee_text};
use crate::{personal_facts, register_facts};

/// Fields a correction may clear (JSON `null`). The rest always hold a value
/// once recorded: removing a hire, exit or birth date, a 사번 or a pay is not a
/// 정정 (an exit is rescinded through the exit case).
const CLEARABLE: [&str; 3] = ["job", "work_email", "probation_end_date"];

fn date(field: &str, text: &str) -> Result<Date, HrError> {
    parse_yyyy_mm_dd(text.trim())
        .map_err(|_| HrError::validation(format!("{field} must be a YYYY-MM-DD date")))
}

fn not_future(field: &str, text: &str) -> Result<String, HrError> {
    let day = date(field, text)?;
    if day > today_kst() {
        return Err(HrError::validation(format!(
            "{field} must not be in the future (KST)"
        )));
    }
    Ok(day.to_string())
}

fn kernel(error: KernelError) -> HrError {
    HrError::from_kernel(error)
}

/// Whole won (E5): a JSON number or a canonical digit string.
fn whole_won(value: &Value) -> Result<String, HrError> {
    let invalid = || HrError::validation("base_pay must be whole won, 0 or more");
    match value {
        Value::Number(number) => number
            .as_u64()
            .map(|won| won.to_string())
            .ok_or_else(invalid),
        Value::String(text) => {
            let text = text.trim();
            let canonical = text == "0"
                || (!text.is_empty()
                    && text.len() <= 12
                    && !text.starts_with('0')
                    && text.chars().all(|c| c.is_ascii_digit()));
            canonical.then(|| text.to_owned()).ok_or_else(invalid)
        }
        _ => Err(invalid()),
    }
}

/// The stored text of a corrected value; `None` clears the field.
pub(crate) fn normalize_value(field: &str, value: &Value) -> Result<Option<String>, HrError> {
    if register_facts::is_register_field(field) {
        return register_facts::normalize(field, value);
    }
    if personal_facts::is_personal_field(field) {
        return personal_facts::normalize(field, value);
    }
    if value.is_null() {
        return if CLEARABLE.contains(&field) {
            Ok(None)
        } else {
            Err(HrError::validation(format!("{field} cannot be cleared")))
        };
    }
    if field == "base_pay" {
        return whole_won(value).map(Some);
    }
    let text = value
        .as_str()
        .ok_or_else(|| HrError::validation(format!("changes.{field} must be a string")))?;
    if kind_for_field(field).is_some() {
        return uuid::Uuid::parse_str(text.trim())
            .map(|id| Some(id.to_string()))
            .map_err(|_| HrError::validation(format!("changes.{field} must be a UUID")));
    }
    let upper = text.trim().to_ascii_uppercase();
    let stored = match field {
        "name" | "employee_number" => required_employee_text(text.to_owned(), field)?,
        "job" => match text.trim() {
            "" => return Ok(None),
            _ => required_employee_text(text.to_owned(), field)?,
        },
        "hire_date" | "exit_date" => not_future(field, text)?,
        "birth_date" => {
            let day = date(field, text)?;
            validate_birth_date(day, today_kst()).map_err(kernel)?;
            day.to_string()
        }
        "probation_end_date" => date(field, text)?.to_string(),
        "work_email" => normalize_work_email(text).map_err(kernel)?,
        "id_type" => IdType::parse(&upper).map_err(kernel)?.as_str().to_owned(),
        "employment_type" => EmploymentType::parse(&upper)
            .map_err(kernel)?
            .as_str()
            .to_owned(),
        "pay_unit" => PayUnit::parse(&upper).map_err(kernel)?.as_str().to_owned(),
        "phone" => normalize_phone_e164(text.to_owned())?,
        other => {
            return Err(HrError::validation(format!(
                "{other} is not a correctable field"
            )));
        }
    };
    Ok(Some(stored))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn values_are_stored_in_one_form() {
        let norm = |field: &str, value: Value| normalize_value(field, &value).unwrap();
        assert_eq!(norm("id_type", json!(" arc ")), Some("ARC".into()));
        assert_eq!(norm("pay_unit", json!("monthly")), Some("MONTHLY".into()));
        assert_eq!(norm("base_pay", json!(3_000_000)), Some("3000000".into()));
        assert_eq!(norm("job", json!("  ")), None);
        assert_eq!(norm("work_email", Value::Null), None);
        assert_eq!(norm("employee_number", json!(" E-7 ")), Some("E-7".into()));
    }

    #[test]
    fn bad_values_and_clearing_a_kept_field_are_422() {
        for (field, value) in [
            ("exit_date", Value::Null),
            ("employee_number", json!("")),
            ("birth_date", json!("1899-12-31")),
            ("exit_date", json!("2999-01-01")),
            ("base_pay", json!("3,000,000")),
            ("base_pay", json!(-1)),
            ("pay_unit", json!("WEEKLY")),
            ("id_type", json!("PASSPORT")),
            ("company", json!("X")),
        ] {
            assert!(normalize_value(field, &value).is_err(), "{field} {value}");
        }
    }
}
