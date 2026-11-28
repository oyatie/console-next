// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{SubmittableCandidate, WORKFLOW_AUTHORITY_ROLE_KEYS};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub(super) struct SubmittableDefinitionListResponse {
    reviewer_role_keys: &'static [&'static str],
    items: Vec<SubmittableDefinitionResponse>,
}

/// A workflow definition the caller may START from the draft template gallery.
/// Carries only the metadata definitions actually hold — no invented
/// icon/desc/tone (those are frontend presentation keyed off `workflow_key` /
/// `object_type`). `active_version` is the version a `POST /workflow-runs` start
/// binds to.
#[derive(Debug, Serialize)]
pub(super) struct SubmittableDefinitionResponse {
    id: Uuid,
    workflow_key: String,
    display_name: String,
    object_type: String,
    active_version: i32,
    required_approval_line: bool,
    required_payment_line: bool,
    allow_approval_line_override: bool,
}

impl SubmittableDefinitionListResponse {
    pub(super) fn new(items: Vec<SubmittableDefinitionResponse>) -> Self {
        Self {
            items,
            reviewer_role_keys: &WORKFLOW_AUTHORITY_ROLE_KEYS,
        }
    }
}

impl From<SubmittableCandidate> for SubmittableDefinitionResponse {
    fn from(c: SubmittableCandidate) -> Self {
        Self {
            id: c.id,
            workflow_key: c.workflow_key,
            display_name: c.display_name,
            object_type: c.object_type,
            active_version: c.active_version,
            required_approval_line: c.required_approval_line,
            required_payment_line: c.required_payment_line,
            allow_approval_line_override: c.allow_approval_line_override,
        }
    }
}
