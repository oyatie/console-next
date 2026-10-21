use super::*;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateDraftBody {
    pub(super) title: String,
    pub(super) body: String,
    pub(super) category: Option<String>,
    pub(super) audience: Option<NoticeAudienceInput>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateDraftBody {
    pub(super) title: Option<String>,
    pub(super) body: Option<String>,
    pub(super) category: Option<String>,
    pub(super) audience: Option<NoticeAudienceInput>,
}
