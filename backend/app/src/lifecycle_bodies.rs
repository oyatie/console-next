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
    #[serde(default)]
    pub(super) retention_until: Option<String>,
}
