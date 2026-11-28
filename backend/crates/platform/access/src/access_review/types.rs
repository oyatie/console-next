// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessReviewSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Uuid>,
    pub period: String,
    pub state: String,
    #[serde(with = "time::serde::rfc3339")]
    pub due_at: OffsetDateTime,
    pub frozen_count: i32,
    pub decided_count: i64,
    pub keep_count: i64,
    pub revoke_count: i64,
    pub reviewer_count: i64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub started_at: Option<OffsetDateTime>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub completed_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessReviewItemOut {
    pub id: Uuid,
    pub grant_id: Uuid,
    pub account_id: Uuid,
    pub account_name: String,
    pub employee_number: Option<String>,
    pub unit_name: Option<String>,
    pub role_id: Uuid,
    pub role_name_ko: String,
    pub scope_kind: String,
    pub scope_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_node_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_include_descendants: Option<bool>,
    #[serde(with = "time::serde::rfc3339")]
    pub valid_from: OffsetDateTime,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub valid_to: Option<OffsetDateTime>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub last_used_at: Option<OffsetDateTime>,
    pub signals: Vec<String>,
    pub decision: Option<String>,
    pub reason_code: Option<String>,
    pub reason_note: Option<String>,
    pub decided_by: Option<Uuid>,
    pub decided_by_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub decided_at: Option<OffsetDateTime>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub applied_at: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessReviewDetail {
    pub summary: AccessReviewSummary,
    pub items: Vec<AccessReviewItemOut>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccessReviewDecisionKind {
    Keep,
    Revoke,
}

impl AccessReviewDecisionKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Keep => "KEEP",
            Self::Revoke => "REVOKE",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AccessReviewDecisionInput {
    pub item_id: Uuid,
    pub decision: AccessReviewDecisionKind,
    #[serde(default)]
    pub reason_code: Option<String>,
    #[serde(default)]
    pub reason_note: Option<String>,
}
