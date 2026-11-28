use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(super) struct TransitionLifecycleRequest {
    pub(super) to_state: String,
    pub(super) reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(super) struct SetLifecycleHoldRequest {
    pub(super) legal_hold: bool,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub(super) expected_updated_at: Option<OffsetDateTime>,
    #[serde(default)]
    pub(super) retention_until: Option<String>,
}
