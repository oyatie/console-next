use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SettleBody {
    /// Legacy client hint; aggregate ownership is authoritative.
    #[serde(default, rename = "branchId")]
    pub(super) _branch_hint: Option<Uuid>,
    #[serde(deserialize_with = "deserialize_enum_28")]
    pub(super) currency_code: String,
    pub(super) amount_minor: i64,
    pub(super) settled_at: OffsetDateTime,
}

fn deserialize_enum_28<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(deserializer, &["KRW"])
}
