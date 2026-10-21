use super::*;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateEmployeeAttendanceRecordRequest {
    #[serde(deserialize_with = "deserialize_enum_1")]
    pub(super) kind: String,
    pub(super) idempotency_key: String,
    #[serde(default)]
    pub(super) note: Option<String>,
}

fn deserialize_enum_1<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &[
            "CLOCK_IN",
            "OUT_FOR_WORK",
            "BUSINESS_TRIP",
            "RETURNED",
            "CLOCK_OUT",
        ],
    )
}
