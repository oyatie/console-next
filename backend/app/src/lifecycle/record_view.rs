// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_db::lifecycle as lifecycle_db;
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleTransitionResponse {
    from_state: String,
    to_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    actor: Option<Uuid>,
    reason: String,
    #[serde(with = "time::serde::rfc3339")]
    occurred_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LifecycleResponse {
    object_type: String,
    object_id: Uuid,
    current_state: String,
    legal_hold: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    retention_until: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) available_transitions: Option<Vec<String>>,
    transitions: Vec<LifecycleTransitionResponse>,
}

pub(super) fn lifecycle_response(
    record: lifecycle_db::LifecycleRecord,
    transitions: Vec<lifecycle_db::LifecycleTransitionRecord>,
) -> LifecycleResponse {
    LifecycleResponse {
        object_type: record.object_type,
        object_id: record.object_id,
        current_state: record.current_state,
        legal_hold: record.legal_hold,
        retention_until: record.retention_until.map(|d| d.to_string()),
        created_at: record.created_at,
        updated_at: record.updated_at,
        available_transitions: None,
        transitions: transitions
            .into_iter()
            .map(|t| LifecycleTransitionResponse {
                from_state: t.from_state,
                to_state: t.to_state,
                actor: t.actor,
                reason: t.reason,
                occurred_at: t.occurred_at,
            })
            .collect(),
    }
}
