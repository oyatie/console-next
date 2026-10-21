//! Audit context returned by the existing tenant- and branch-confined log read.

#[derive(Debug, serde::Serialize, sqlx::FromRow)]
pub(super) struct AuditRecordContext {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub auth_method: Option<String>,
    pub device: Option<String>,
    pub classification_badges: Option<Vec<String>>,
    pub anomaly: Option<bool>,
    pub reason: Option<String>,
    pub trace_id: String,
    pub span_id: String,
    pub source: Option<String>,
    pub change_mode: Option<String>,
    pub reason_code: Option<String>,
    pub decision_snapshot: Option<serde_json::Value>,
    pub command_id: Option<uuid::Uuid>,
    pub scope_ids: Option<Vec<uuid::Uuid>>,
    pub actor_kind: Option<String>,
    pub principal_type: Option<String>,
    pub session_id: Option<uuid::Uuid>,
    pub outcome: Option<String>,
    pub actor_display: Option<String>,
    pub actor_employer: Option<String>,
    pub row_hash_version: i16,
}
