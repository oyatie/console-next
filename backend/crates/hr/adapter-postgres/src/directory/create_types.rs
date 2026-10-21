//! Registration requests; re-exported by `types` for existing callers.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::create_duplicates::DuplicateOverride;
use super::create_facts::{CreateEmployeeContract, NormalizedEmployeeFacts};

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateEmployeeRequest {
    /// Omitted or blank: the server assigns the next `E-000001`-style number.
    #[serde(default)]
    pub employee_number: String,
    pub name: String,
    #[serde(default)]
    pub company: String,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_enum_39")]
    pub employment_type: String,
    #[serde(default)]
    pub phone: String,
    /// Legacy free text, accepted for compatibility and ignored when
    /// `org_unit_id` is given (the unit name is projected instead).
    #[serde(default)]
    pub org_unit: String,
    /// When given, an ACTIVE Site/Department/Team of this tenant.
    /// Omitted: 미배치.
    #[serde(default)]
    pub org_unit_id: Option<Uuid>,
    #[serde(default)]
    pub position: String,
    #[serde(default)]
    pub site: String,
    #[serde(default)]
    pub home_branch_id: Option<Uuid>,
    /// Legacy decimal pay; may be omitted when `base_pay_won` is given (it is
    /// then that amount), and must equal it when both are given.
    #[serde(default)]
    pub base_pay: String,
    pub idempotency_key: String,
    /// Required on `POST /api/v1/employees` (`YYYY-MM-DD`, not in the future,
    /// KST); the ONBOARD event takes effect on it. Optional only for the
    /// recruiting-hire compatibility path, which records today (KST).
    #[serde(default)]
    pub hire_date: Option<String>,
    /// CONTRACT only. Defaults to `hire_date`.
    #[serde(default)]
    pub contract_start_date: Option<String>,
    /// Optional CONTRACT window;
    /// refused for any other employment type.
    #[serde(default)]
    pub contract_end_date: Option<String>,
    // --- EMP-CREATE: the EMP-MODEL facts recorded with the registration ---
    #[serde(default)]
    pub work_email: Option<String>,
    #[serde(default)]
    pub birth_date: Option<String>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_enum_11")]
    pub id_type: Option<String>,
    #[serde(default)]
    pub base_pay_won: Option<i64>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_enum_12")]
    pub pay_unit: Option<String>,
    #[serde(default)]
    pub probation_end_date: Option<String>,
    #[serde(default)]
    pub contract: Option<CreateEmployeeContract>,
    /// BW-19: confirms a different person after a 409 `duplicate_candidate`.
    #[serde(default)]
    pub duplicate_override: Option<DuplicateOverride>,
    /// MR-22: where the person works, recorded with the registration. The
    /// 사업장 alone is enough (its 법인 follows); a 법인 needs its 사업장.
    /// Both absent: the 사업장 the unit sits in, else 미배치.
    #[serde(default)]
    pub legal_entity_id: Option<Uuid>,
    #[serde(default)]
    pub workplace_id: Option<Uuid>,
}

#[derive(Debug, Default, Serialize)]
pub struct NormalizedCreateEmployeeRequest {
    pub employee_number: String,
    pub name: String,
    pub company: String,
    pub employment_type: Option<String>,
    pub phone_e164: Option<String>,
    pub org_unit: String,
    /// Skipped when absent so the recruiting-hire request hash (and with it
    /// every stored idempotency reservation) is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit_id: Option<Uuid>,
    pub position: String,
    pub site: String,
    pub home_branch_id: Option<Uuid>,
    pub base_pay: Option<String>,
    pub idempotency_key: String,
    /// The three dates are skipped when absent so the recruiting-hire request
    /// hash (and every stored idempotency reservation) is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hire_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_end_date: Option<String>,
    /// EMP-CREATE; empty facts add nothing to the request hash.
    #[serde(flatten)]
    pub facts: NormalizedEmployeeFacts,
    /// BW-19; absent adds nothing to the request hash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_override: Option<DuplicateOverride>,
    /// MR-22; absent adds nothing to the request hash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legal_entity_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workplace_id: Option<Uuid>,
}

fn deserialize_enum_11<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_optional_enum_string(
        deserializer,
        &["RRN", "ARC", "DOMESTIC_RESIDENCE", "NOT_ISSUED"],
    )
}

fn deserialize_enum_12<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_optional_enum_string(
        deserializer,
        &["MONTHLY", "HOURLY", "DAILY", "ANNUAL"],
    )
}

fn deserialize_enum_39<'de, D>(deserializer: D) -> Result<String, D::Error>
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
