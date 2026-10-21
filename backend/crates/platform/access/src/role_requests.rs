//! The request bodies and queries of the role use cases.

use serde::Deserialize;

use crate::dto::{LineIn, StepUp, nullable};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRole {
    pub(crate) name_ko: String,
    #[serde(default)]
    pub(crate) name_en: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    #[serde(deserialize_with = "deserialize_enum_31")]
    pub(crate) status: Option<String>,
    pub(crate) lines: Vec<LineIn>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRole {
    pub(crate) expected_version: i32,
    #[serde(default)]
    pub(crate) name_ko: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub(crate) name_en: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub(crate) description: Option<Option<String>>,
    #[serde(default)]
    pub(crate) lines: Option<Vec<LineIn>>,
    #[serde(default)]
    pub(crate) reason_code: Option<String>,
    #[serde(default)]
    pub(crate) reason_note: Option<String>,
    #[serde(default)]
    pub(crate) step_up: Option<StepUp>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetStatus {
    pub(crate) expected_version: i32,
    #[serde(deserialize_with = "deserialize_enum_32")]
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) reason_code: Option<String>,
    #[serde(default)]
    pub(crate) reason_note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StatusFilter {
    pub(crate) status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExpectedVersion {
    pub(crate) expected_version: i32,
}

fn deserialize_enum_31<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_optional_enum_string(
        deserializer,
        &["DRAFT", "ACTIVE"],
    )
}

fn deserialize_enum_32<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(deserializer, &["ACTIVE", "RETIRED"])
}
