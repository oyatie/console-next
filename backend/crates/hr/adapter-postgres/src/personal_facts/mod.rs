//! 인적사항 extras (MR-34, lane EMP-FACTS): 한자 · 영문 성명, 국적, 개인 메일,
//! 비상연락처, 사진 and 그룹 입사일.
//!
//! They change only through the MR-8 correction path (`PATCH
//! /employees/{id}`, its BW-17 request, the bulk profile), one
//! `employee_corrections` row per item: `corrections` calls [`normalize`],
//! [`store::check_in_tx`] and [`store::write_in_tx`]. A 사진 is uploaded first
//! ([`photo`]: issue a presigned PUT, then confirm), and its upload id is the
//! correction value.
//!
//! A normalized value is text the same function accepts again (a filed
//! request stores it and the decision re-normalizes it); `None` clears the
//! item back to 미입력; the 비상연락처 list is its JSON.

pub mod photo;
pub mod read;
pub(crate) mod store;

use console_hr_domain::personal::{
    EmergencyContactInput, PERSONAL_FIELDS, normalize_name_en, normalize_name_hanja,
    normalize_nationality, validate_emergency_contacts,
};
use console_hr_domain::profile::facts::normalize_email;
use console_hr_domain::text::parse_yyyy_mm_dd;
use serde_json::Value;
use uuid::Uuid;

use crate::HrError;
use crate::directory::normalize::normalize_phone_e164;

/// Whether `field` is an item this module stores.
#[must_use]
pub fn is_personal_field(field: &str) -> bool {
    PERSONAL_FIELDS.contains(&field)
}

/// The stored text of one item; `None` clears it (미입력).
pub fn normalize(field: &str, value: &Value) -> Result<Option<String>, HrError> {
    if field == "emergency_contacts" {
        return emergency_contacts(value);
    }
    let text = match value {
        Value::Null => return Ok(None),
        Value::String(text) => text.as_str(),
        _ => {
            return Err(HrError::validation(format!(
                "changes.{field} must be a string or null"
            )));
        }
    };
    let kernel = HrError::from_kernel;
    match field {
        "name_hanja" => normalize_name_hanja(text).map_err(kernel),
        "name_en" => normalize_name_en(text).map_err(kernel),
        "nationality" => normalize_nationality(text).map_err(kernel),
        "personal_email" => match text.trim() {
            "" => Ok(None),
            raw => normalize_email(raw, field).map(Some).map_err(kernel),
        },
        "photo" => match text.trim() {
            "" => Ok(None),
            raw => Uuid::parse_str(raw)
                .map(|id| Some(id.to_string()))
                .map_err(|_| HrError::validation("changes.photo must be a photo upload id")),
        },
        "group_service_start_date" => match text.trim() {
            "" => Ok(None),
            raw => parse_yyyy_mm_dd(raw)
                .map(|day| Some(day.to_string()))
                .map_err(|_| {
                    HrError::validation("group_service_start_date must be a YYYY-MM-DD date")
                }),
        },
        other => Err(HrError::validation(format!(
            "{other} is not a personal item"
        ))),
    }
}

/// The 비상연락처 list as JSON, phones in E.164; an empty list clears it.
fn emergency_contacts(value: &Value) -> Result<Option<String>, HrError> {
    let value = match value {
        Value::Null => return Ok(None),
        Value::String(text) if text.trim().is_empty() => return Ok(None),
        Value::String(text) => serde_json::from_str(text).map_err(|_| shape())?,
        other => other.clone(),
    };
    let rows: Vec<EmergencyContactInput> = serde_json::from_value(value).map_err(|_| shape())?;
    for row in &rows {
        store::ensure_emergency_contact_notice(row.contact_notified == Some(true))?;
    }
    let mut rows = validate_emergency_contacts(rows).map_err(HrError::from_kernel)?;
    if rows.is_empty() {
        return Ok(None);
    }
    for row in &mut rows {
        row.phone = normalize_phone_e164(std::mem::take(&mut row.phone))?;
    }
    serde_json::to_string(&rows)
        .map(Some)
        .map_err(|_| HrError::validation("changes.emergency_contacts could not be stored"))
}

fn shape() -> HrError {
    HrError::validation(
        "changes.emergency_contacts must be a list of {name, relation, phone, contact_notified: true} (relation: SPOUSE, PARENT, CHILD, SIBLING, RELATIVE or OTHER)",
    )
}

/// The ledger value of a stored text: JSON null for 미입력, the 비상연락처
/// list as JSON, any other item as a string.
#[must_use]
pub fn ledger_value(field: &str, stored: Option<&str>) -> Value {
    match (field, stored) {
        (_, None) => Value::Null,
        ("emergency_contacts", Some(json)) => serde_json::from_str(json).unwrap_or(Value::Null),
        (_, Some(text)) => Value::String(text.to_owned()),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn items_are_stored_in_one_form_that_normalizes_again() {
        let norm = |field: &str, value: Value| normalize(field, &value).unwrap();
        assert_eq!(norm("nationality", json!("vn")), Some("VN".into()));
        assert_eq!(
            norm("personal_email", json!(" Me@Example.COM ")),
            Some("Me@example.com".into())
        );
        assert_eq!(norm("personal_email", json!("")), None);
        assert_eq!(
            norm("group_service_start_date", json!("2019-01-02")),
            Some("2019-01-02".into())
        );
        let contacts = norm(
            "emergency_contacts",
            json!([{ "name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678", "contact_notified": true }]),
        )
        .unwrap();
        assert_eq!(
            ledger_value("emergency_contacts", Some(&contacts)),
            json!([{ "name": "이하나", "relation": "SPOUSE", "phone": "+821012345678", "contact_notified": true }])
        );
        assert_eq!(
            norm("emergency_contacts", Value::String(contacts.clone())),
            Some(contacts),
            "a filed request's stored text is accepted again"
        );
        assert_eq!(norm("emergency_contacts", json!([])), None);
        assert_eq!(norm("photo", Value::Null), None);
    }

    #[test]
    fn emergency_contacts_refuse_missing_null_or_false_notice_confirmation() {
        for confirmation in [None, Some(Value::Null), Some(json!(false))] {
            let mut contact =
                json!({ "name": "이하나", "relation": "SPOUSE", "phone": "010-1234-5678" });
            if let Some(confirmation) = confirmation {
                contact["contact_notified"] = confirmation;
            }
            let err = normalize("emergency_contacts", &json!([contact])).unwrap_err();
            assert_eq!(err.status, http::StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(err.code, "emergency_contact_notice_unconfirmed");
        }
    }

    #[test]
    fn bad_values_are_422() {
        for (field, value) in [
            ("name_en", json!("김하늘")),
            ("nationality", json!(1)),
            ("personal_email", json!("nobody")),
            ("photo", json!("not-an-id")),
            ("group_service_start_date", json!("2019/01/02")),
            (
                "emergency_contacts",
                json!([{ "name": "이", "relation": "FRIEND", "phone": "010", "contact_notified": true }]),
            ),
            (
                "emergency_contacts",
                json!([{ "name": "이", "relation": "OTHER", "phone": "abc", "contact_notified": true }]),
            ),
        ] {
            assert!(normalize(field, &value).is_err(), "{field} {value}");
        }
    }
}
