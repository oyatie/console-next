// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, Clone, Default)]
pub struct MyAccessLogQuery {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MyAccessLogEvent {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub actor_name: String,
    pub actor_team: Option<String>,
    pub action: String,
    pub field: Option<String>,
    pub reason_code: Option<String>,
    pub target_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MyAccessLogPage {
    pub items: Vec<MyAccessLogEvent>,
    pub next_cursor: Option<String>,
}
