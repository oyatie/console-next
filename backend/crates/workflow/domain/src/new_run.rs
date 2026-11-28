// SPDX-License-Identifier: LicenseRef-Proprietary
use super::TriggerType;
use console_kernel_core::{OrgId, UserId};

/// Row to INSERT into `workflow_runs` (status STARTING). The id is pre-generated
/// by the caller so deterministic idempotency/natural keys can be derived before
/// the row exists.
#[derive(Debug, Clone)]
pub struct NewRun {
    pub id: uuid::Uuid,
    pub org_id: OrgId,
    pub definition_id: uuid::Uuid,
    pub definition_version: i32,
    /// Server-validated per-run graph, pinned only for customized approval lines.
    pub effective_definition: Option<serde_json::Value>,
    pub trigger_type: TriggerType,
    pub object_type: Option<String>,
    pub object_id: Option<uuid::Uuid>,
    pub idempotency_key: String,
    pub correlation_id: String,
    pub trace_id: Option<String>,
    pub input_payload: serde_json::Value,
    pub context_payload: serde_json::Value,
    pub initiated_by: Option<UserId>,
    /// The `workflow_schedules` row that fired this run (`TriggerType::Schedule`
    /// provenance for the per-schedule run-history surface); `None` otherwise.
    pub schedule_id: Option<uuid::Uuid>,
}
