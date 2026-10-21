use super::*;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ObjectTypeLifecycleRequest {
    pub(super) to_state: SchemaLifecycleState,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AttachObjectPolicyRequest {
    pub(super) effect: Effect,
    #[serde(default)]
    pub(super) conditions: Vec<Condition>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LifecycleRequest {
    pub(super) to_state: InstanceLifecycleState,
    #[serde(default)]
    pub(super) reason: Option<String>,
    #[serde(default)]
    pub(super) checklist_all_acknowledged: Option<bool>,
    #[serde(default)]
    pub(super) four_eyes_request_ref: Option<Uuid>,
}
