//! Create-employee request normalisation (moved from `app/src/hr.rs`,
//! R2-people). Returns `HrError`, so it stays in the adapter until the
//! map's step 0a rewrite moves it to `hr-domain`.

use console_hr_domain::profile::enums::EmploymentType;
use console_hr_domain::text::{normalize_enum_text, normalize_optional_text, parse_yyyy_mm_dd};
use console_kernel_core::{KernelError, kr::PhoneE164};

use crate::HrError;
use crate::directory::create_facts::{RawEmployeeFacts, normalize_employee_facts};
use crate::directory::types::{CreateEmployeeRequest, NormalizedCreateEmployeeRequest};
use crate::idempotency::normalize_idempotency_key;

pub fn required_employee_text(value: String, field: &str) -> Result<String, HrError> {
    let normalized = value.trim().to_owned();
    if normalized.is_empty() || normalized.chars().count() > 200 {
        return Err(KernelError::validation(format!(
            "{field} is required and must be 200 characters or fewer"
        ))
        .with_field(field)
        .into());
    }
    Ok(normalized)
}

fn optional_employee_text(value: String, field: &str) -> Result<String, HrError> {
    if value.trim().is_empty() {
        Ok(String::new())
    } else {
        required_employee_text(value, field)
    }
}

/// The kernel's one phone rule ([`PhoneE164`]), so the register refuses a
/// letter typed for a digit instead of storing a different number.
pub fn normalize_phone_e164(value: String) -> Result<String, HrError> {
    PhoneE164::parse(&value)
        .map(|phone| phone.as_str().to_owned())
        .map_err(|_| HrError::validation("phone must be an E.164 number"))
}

pub fn normalize_create_employee_request(
    body: CreateEmployeeRequest,
) -> Result<NormalizedCreateEmployeeRequest, HrError> {
    // EMP-CREATE: any of the nine employment types (E13).
    let employment_type =
        normalize_optional_text(Some(body.employment_type)).map(normalize_enum_text);
    let kind = employment_type
        .as_deref()
        .map(EmploymentType::parse)
        .transpose()?;
    let hire_date = normalize_optional_text(body.hire_date)
        .map(|raw| parse_yyyy_mm_dd(&raw))
        .transpose()?;
    // BW-19 4: a future hire date registers 입사 예정 (PRE_HIRE) with a
    // scheduled ONBOARD (create_onboard.rs); it is no longer refused.
    let facts = normalize_employee_facts(
        RawEmployeeFacts {
            work_email: body.work_email,
            birth_date: body.birth_date,
            id_type: body.id_type,
            base_pay_won: body.base_pay_won,
            pay_unit: body.pay_unit,
            probation_end_date: body.probation_end_date,
            contract: body.contract,
        },
        kind,
        hire_date,
    )?;
    let base_pay = match (body.base_pay.trim(), facts.base_pay_won) {
        ("", Some(won)) => Some(format!("{won}.00")),
        ("", None) => None,
        (_, Some(won)) => {
            let base_pay = normalize_employee_base_pay(body.base_pay)?;
            if base_pay != format!("{won}.00") {
                return Err(HrError::validation("base_pay must equal base_pay_won"));
            }
            Some(base_pay)
        }
        (_, None) => Some(normalize_employee_base_pay(body.base_pay)?),
    };
    // A CONTRACT registration's first contract carries the legacy profile
    // window when the legacy fields are omitted, and must agree with them.
    let first = facts
        .contract
        .as_ref()
        .filter(|_| employment_type.as_deref() == Some("CONTRACT"));
    let contract_start_date = normalize_optional_text(body.contract_start_date)
        .or_else(|| first.map(|c| c.start_date.clone()))
        .map(|raw| parse_yyyy_mm_dd(&raw))
        .transpose()?;
    let contract_end_date = normalize_optional_text(body.contract_end_date)
        .or_else(|| first.and_then(|c| c.end_date.clone()))
        .map(|raw| parse_yyyy_mm_dd(&raw))
        .transpose()?;
    if let Some(first) = first
        && (contract_start_date.map(|d| d.to_string()) != Some(first.start_date.clone())
            || contract_end_date.map(|d| d.to_string()) != first.end_date)
    {
        return Err(HrError::validation(
            "contract_start_date and contract_end_date must match contract",
        ));
    }
    if employment_type.as_deref() != Some("CONTRACT")
        && (contract_start_date.is_some() || contract_end_date.is_some())
    {
        return Err(HrError::validation(
            "contract_start_date and contract_end_date are only allowed for CONTRACT employment",
        ));
    }
    let contract_start_date = contract_start_date.or(if contract_end_date.is_some() {
        hire_date
    } else {
        None
    });
    if let (Some(start), Some(end)) = (contract_start_date, contract_end_date)
        && end < start
    {
        return Err(HrError::validation(
            "contract_end_date must be on or after contract_start_date",
        ));
    }
    Ok(NormalizedCreateEmployeeRequest {
        // Blank: assigned by the server at create time.
        employee_number: if body.employee_number.trim().is_empty() {
            String::new()
        } else {
            required_employee_text(body.employee_number, "employee_number")?
        },
        name: required_employee_text(body.name, "name")?,
        company: optional_employee_text(body.company, "company")?,
        employment_type,
        phone_e164: normalize_optional_text(Some(body.phone))
            .map(normalize_phone_e164)
            .transpose()?,
        org_unit: if body.org_unit_id.is_some() {
            body.org_unit.trim().to_owned()
        } else {
            optional_employee_text(body.org_unit, "org_unit")?
        },
        org_unit_id: body.org_unit_id,
        position: optional_employee_text(body.position, "position")?,
        site: optional_employee_text(body.site, "site")?,
        home_branch_id: body.home_branch_id,
        base_pay,
        idempotency_key: normalize_idempotency_key(body.idempotency_key)?,
        hire_date: hire_date.map(|date| date.to_string()),
        contract_start_date: contract_start_date.map(|date| date.to_string()),
        contract_end_date: contract_end_date.map(|date| date.to_string()),
        facts,
        duplicate_override: body.duplicate_override,
        legal_entity_id: body.legal_entity_id,
        workplace_id: body.workplace_id,
    })
}

/// Produces a fixed-scale decimal accepted by PostgreSQL `NUMERIC(14,2)` without
/// float rounding, exponent notation, leading zeros, or silent truncation.
pub fn normalize_employee_base_pay(value: String) -> Result<String, HrError> {
    let value = value.trim();
    let (whole, fraction) = value
        .split_once('.')
        .map_or((value, None), |(whole, fraction)| (whole, Some(fraction)));
    let valid_whole = whole == "0"
        || (whole.len() <= 12
            && !whole.starts_with('0')
            && whole.chars().all(|character| character.is_ascii_digit()));
    let valid_fraction = fraction.is_none_or(|fraction| {
        !fraction.is_empty()
            && fraction.len() <= 2
            && fraction.chars().all(|character| character.is_ascii_digit())
    });
    if !valid_whole || !valid_fraction {
        return Err(HrError::validation(
            "base_pay must be a canonical NUMERIC(14,2) decimal",
        ));
    }
    let fraction = fraction.unwrap_or("0");
    Ok(format!("{whole}.{fraction:0<2}"))
}

#[cfg(test)]
mod tests {
    use super::required_employee_text;

    #[test]
    fn required_text_counts_characters_after_trimming() {
        for character in ["A", "김", "😀"] {
            let text = character.repeat(200);
            assert_eq!(
                required_employee_text(format!(" {text} "), "name").ok(),
                Some(text)
            );
            assert!(required_employee_text(character.repeat(201), "name").is_err());
        }
        assert!(required_employee_text(" \t\n ".to_owned(), "name").is_err());
    }
}
