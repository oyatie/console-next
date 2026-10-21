use super::*;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateObjectLinkRequest {
    pub(super) src_kind: String,
    pub(super) src_id: String,
    pub(super) dst_kind: String,
    pub(super) dst_id: String,
    pub(super) link_type: String,
}
