//! The 재입사 request (BW-19 2) and its normalisation.

use console_hr_domain::profile::enums::EmploymentType;
use console_hr_domain::text::{normalize_enum_text, normalize_optional_text, parse_yyyy_mm_dd};
use serde::Deserialize;
use uuid::Uuid;

use crate::HrError;
use crate::digest::sha256_hex;
use crate::directory::normalize::required_employee_text;
use crate::idempotency::normalize_idempotency_key;

/// `POST /api/v1/employees/{id}/rehire`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RehireEmployeeRequest {
    /// The new period's first day (`YYYY-MM-DD`, after the last 퇴직일).
    pub hire_date: String,
    #[serde(deserialize_with = "deserialize_enum_10")]
    pub employment_type: String,
    pub org_unit_id: Uuid,
    pub position: String,
    /// Defaults to the 법인 of the last period.
    #[serde(default)]
    pub company: Option<String>,
    /// Required for CONTRACT, refused otherwise.
    #[serde(default)]
    pub contract_end_date: Option<String>,
    /// Required only when the person has no employment profile (a former
    /// employee loaded by import); otherwise the profile keeps its contact.
    #[serde(default)]
    pub phone: Option<String>,
    /// Required only with `phone` (no profile yet).
    #[serde(default)]
    pub base_pay_won: Option<i64>,
    pub idempotency_key: String,
}

impl RehireEmployeeRequest {
    /// The idempotency hash: this person and every normalised field.
    pub fn request_hash(&self, employee_id: Uuid) -> String {
        sha256_hex(
            format!(
                "rehire:{employee_id}:{}:{}:{}:{}:{:?}:{:?}:{:?}:{:?}",
                self.hire_date,
                self.employment_type,
                self.org_unit_id,
                self.position,
                self.company,
                self.contract_end_date,
                self.phone,
                self.base_pay_won
            )
            .as_bytes(),
        )
    }
}

/// Trims and checks the request: a known employment type, a date, and a
/// contract end exactly when the type is CONTRACT (on or after the first day).
///
/// # Errors
/// 422 `validation`.
pub fn normalize_rehire(
    mut request: RehireEmployeeRequest,
) -> Result<RehireEmployeeRequest, HrError> {
    request.employment_type = normalize_enum_text(request.employment_type);
    EmploymentType::parse(&request.employment_type)?;
    let hire = parse_yyyy_mm_dd(request.hire_date.trim())?;
    request.hire_date = hire.to_string();
    request.position = required_employee_text(request.position, "position")?;
    request.company = normalize_optional_text(request.company);
    request.idempotency_key = normalize_idempotency_key(request.idempotency_key)?;
    let end = normalize_optional_text(request.contract_end_date.take())
        .map(|raw| parse_yyyy_mm_dd(&raw))
        .transpose()?;
    match (request.employment_type.as_str(), end) {
        ("CONTRACT", None) => {
            return Err(HrError::validation(
                "contract_end_date is required for CONTRACT employment",
            ));
        }
        ("CONTRACT", Some(end)) if end < hire => {
            return Err(HrError::validation(
                "contract_end_date must be on or after hire_date",
            ));
        }
        ("CONTRACT", Some(_)) => {}
        (_, Some(_)) => {
            return Err(HrError::validation(
                "contract_end_date is only for CONTRACT employment",
            ));
        }
        (_, None) => {}
    }
    request.contract_end_date = end.map(|date| date.to_string());
    Ok(request)
}

pub(super) fn validate_period(exit: Option<&str>, hire: &str) -> Result<(), HrError> {
    let hire_date = parse_yyyy_mm_dd(hire)?;
    let exit_date = exit.map(parse_yyyy_mm_dd).transpose()?;
    console_hr_domain::lifecycle::rehire::check_rehire_date(hire_date, exit_date).map_err(|error| {
        HrError {
            status: http::StatusCode::UNPROCESSABLE_ENTITY,
            code: error.code.unwrap_or("validation"),
            message: error.message,
            refusals: Some(
                serde_json::json!([{ "field": "hire_date", "exit_date": exit, "hire_date": hire }]),
            ),
        }
    })
}

fn deserialize_enum_10<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &[
            "REGULAR",
            "CONTRACT",
            "PART_TIME",
            "INTERN",
            "DAILY",
            "EXECUTIVE",
            "DISPATCHED_IN",
            "OUTSOURCED_ON_SITE",
            "FREELANCE",
        ],
    )
}
