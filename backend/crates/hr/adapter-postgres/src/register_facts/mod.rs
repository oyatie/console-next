//! 근로자 명부 items HR holds itself (MR-23, lane EMP-FACTS): 성별, 주소,
//! 이력 · 경력, the 퇴직 사유 of an exit recorded without an exit case, and
//! 그 밖에 필요한 사항 (근로기준법 §41, 시행령 §20 2·4·5·8·9호).
//!
//! They change only through the MR-8 correction path (`PATCH
//! /employees/{id}` and its BW-17 request), one `employee_corrections` row per
//! item: `corrections` calls [`normalize`], [`store::check_in_tx`] and
//! [`store::write_in_tx`].
//!
//! A normalized value is text the same function accepts again (a filed
//! request stores it and the decision re-normalizes it); `None` clears the
//! item back to 미입력; the address and the career list are their JSON.

pub mod bulk;
pub(crate) mod exit_reason;
pub mod read;
pub(crate) mod store;

use console_entity_domain::{AddressInput, Issues};
use console_hr_domain::register::{
    CareerInput, REGISTER_FIELDS, Sex, normalize_register_note, validate_careers,
};
use console_settings_domain::code_lists::{ReasonDomain, is_tenant_code};
use serde_json::Value;

use crate::HrError;

/// Whether `field` is a register item this module stores.
#[must_use]
pub fn is_register_field(field: &str) -> bool {
    REGISTER_FIELDS.contains(&field)
}

/// The stored text of one register item; `None` clears it (미입력). The
/// 퇴직 사유 is never cleared, only corrected to another code.
pub fn normalize(field: &str, value: &Value) -> Result<Option<String>, HrError> {
    let text = match value {
        Value::Null => None,
        Value::String(text) if text.trim().is_empty() => None,
        Value::String(text) => Some(text.as_str()),
        _ if matches!(field, "address" | "careers") => None,
        _ => {
            return Err(HrError::validation(format!(
                "changes.{field} must be a string or null"
            )));
        }
    };
    match field {
        "sex" => text
            .map(|raw| Sex::parse(raw).map(|sex| sex.as_str().to_owned()))
            .transpose()
            .map_err(HrError::from_kernel),
        "exit_reason" => match text {
            Some(raw) => exit_reason_code(raw).map(Some),
            None => Err(HrError::validation(format!("{field} cannot be cleared"))),
        },
        "register_note" => Ok(text
            .map(|raw| normalize_register_note(raw).map_err(HrError::from_kernel))
            .transpose()?
            .flatten()),
        "address" => address(value),
        "careers" => careers(value),
        other => Err(HrError::validation(format!(
            "{other} is not a register item"
        ))),
    }
}

/// A system `exit_reason` code, or a tenant code (checked against the
/// catalog inside the write, where the tenant's rows are visible).
fn exit_reason_code(raw: &str) -> Result<String, HrError> {
    let code = raw.trim();
    let system = ReasonDomain::ExitReason
        .system_codes()
        .iter()
        .any(|known| known.code == code);
    if system || is_tenant_code(code) {
        Ok(code.to_owned())
    } else {
        Err(HrError::validation(
            "exit_reason must be an exit_reason catalog code",
        ))
    }
}

/// The address as the `KrAddress` JSON (juso result or structured manual
/// entry); a value that is already that JSON text (a filed request) is
/// accepted again.
fn address(value: &Value) -> Result<Option<String>, HrError> {
    let value = match value {
        Value::Null => return Ok(None),
        Value::String(text) if text.trim().is_empty() => return Ok(None),
        Value::String(text) => serde_json::from_str(text)
            .map_err(|_| HrError::validation("changes.address must be an address object"))?,
        other => other.clone(),
    };
    let input: AddressInput = serde_json::from_value(value)
        .map_err(|_| HrError::validation("changes.address must be an address object"))?;
    let mut issues = Issues::default();
    let checked = console_entity_domain::address::validate_address(&mut issues, "address", &input);
    match checked {
        Some(address) if issues.is_empty() => serde_json::to_string(&address)
            .map(Some)
            .map_err(|_| HrError::validation("changes.address could not be stored")),
        _ => Err(HrError {
            refusals: Some(serde_json::to_value(issues.into_vec()).unwrap_or_default()),
            ..HrError::validation("address is incomplete or invalid")
        }),
    }
}

/// The 경력 list as JSON (`[]` = 경력 없음), checked row by row.
fn careers(value: &Value) -> Result<Option<String>, HrError> {
    let value = match value {
        Value::Null => return Ok(None),
        Value::String(text) if text.trim().is_empty() => return Ok(None),
        Value::String(text) => serde_json::from_str(text)
            .map_err(|_| HrError::validation("changes.careers must be a list of careers"))?,
        other => other.clone(),
    };
    let rows: Vec<CareerInput> = serde_json::from_value(value)
        .map_err(|_| HrError::validation("changes.careers must be a list of careers"))?;
    let rows = validate_careers(rows).map_err(HrError::from_kernel)?;
    serde_json::to_string(&rows)
        .map(Some)
        .map_err(|_| HrError::validation("changes.careers could not be stored"))
}

/// The ledger value of a stored text: JSON null for 미입력, the address or
/// career JSON as JSON, any other item as a string.
#[must_use]
pub fn ledger_value(field: &str, stored: Option<&str>) -> Value {
    match (field, stored) {
        (_, None) => Value::Null,
        ("address" | "careers", Some(json)) => serde_json::from_str(json).unwrap_or(Value::Null),
        (_, Some(text)) => Value::String(text.to_owned()),
    }
}

#[cfg(test)]
mod tests;
