// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::validation::deserialize_enum_string;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct QuoteBody {
    pub(super) branch_id: Uuid,
    pub(super) unit_id: Uuid,
    pub(super) customer_name: String,
    pub(super) site_reference: String,
    pub(super) monthly_rate_minor: i64,
    pub(super) duration_months: i32,
    #[serde(deserialize_with = "deserialize_currency")]
    pub(super) currency_code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ApprovalBody {
    #[serde(deserialize_with = "deserialize_approval")]
    pub(super) decision: String,
    pub(super) reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InspectionBody {
    #[serde(deserialize_with = "deserialize_inspection_outcome")]
    pub(super) outcome: String,
    pub(super) findings: String,
    pub(super) maintenance_note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AssessmentBody {
    #[serde(deserialize_with = "deserialize_condition_grade")]
    pub(super) condition_grade: String,
    pub(super) findings: String,
    #[serde(deserialize_with = "deserialize_disposition")]
    pub(super) disposition: String,
}

fn deserialize_currency<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    deserialize_enum_string(deserializer, &["KRW"])
}

fn deserialize_approval<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    deserialize_enum_string(deserializer, &["APPROVED", "DECLINED"])
}

fn deserialize_inspection_outcome<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    deserialize_enum_string(deserializer, &["PASS", "MAINTENANCE_PERFORMED"])
}

fn deserialize_condition_grade<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    deserialize_enum_string(deserializer, &["A", "B", "C", "D"])
}

fn deserialize_disposition<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    deserialize_enum_string(deserializer, &["REPAIR", "REFURBISH", "RESALE", "REDEPLOY"])
}

#[cfg(test)]
mod tests {
    use super::{ApprovalBody, AssessmentBody, InspectionBody, QuoteBody};
    use serde_json::{from_value, json};
    use uuid::Uuid;

    #[test]
    fn request_enums_reject_unsupported_strings() {
        let mut quote = json!({
            "branchId": Uuid::nil(), "unitId": Uuid::nil(), "customerName": "a", "siteReference": "b",
            "monthlyRateMinor": 1, "durationMonths": 1, "currencyCode": "KRW"
        });
        assert!(from_value::<QuoteBody>(quote.clone()).is_ok());
        quote["currencyCode"] = json!("USD");
        assert!(from_value::<QuoteBody>(quote).is_err());
        assert!(from_value::<ApprovalBody>(json!({"decision": "APPROVED"})).is_ok());
        assert!(from_value::<ApprovalBody>(json!({"decision": "approved"})).is_err());
        assert!(from_value::<InspectionBody>(json!({"outcome":"PASS", "findings":"ok"})).is_ok());
        assert!(
            from_value::<InspectionBody>(json!({"outcome":"MISSING", "findings":"ok"})).is_err()
        );
        for (grade, disposition, valid) in [
            ("A", "REPAIR", true),
            ("Z", "REPAIR", false),
            ("A", "NONE", false),
        ] {
            assert_eq!(
                from_value::<AssessmentBody>(json!({
                    "conditionGrade": grade, "disposition": disposition, "findings": "ok"
                }))
                .is_ok(),
                valid
            );
        }
    }
}
