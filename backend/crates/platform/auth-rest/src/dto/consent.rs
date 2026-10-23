use console_platform_request_context::privacy::DocumentRef;
use serde::Deserialize;
use serde::Serialize;
use time::OffsetDateTime;

/// Required first-login privacy/terms acceptance. The booleans are deliberately
/// explicit and separate so the client cannot send one bundled "agree all" flag
/// for legally distinct items.
#[derive(Debug, Deserialize)]
pub(crate) struct PrivacyConsentAcceptRequest {
    // shortcut: N-1 omits references, restore required fields after the compatibility release.
    pub(crate) privacy: Option<DocumentRef>,
    pub(crate) terms: Option<DocumentRef>,
    pub(crate) privacy_collection: bool,
    pub(crate) terms_of_service: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct PrivacyConsentStatusResponse {
    pub(crate) policy_version: String,
    pub(crate) privacy: DocumentRef,
    pub(crate) terms: DocumentRef,
    pub(crate) accepted: bool,
    #[serde(with = "time::serde::rfc3339::option")]
    pub(crate) accepted_at: Option<OffsetDateTime>,
}
