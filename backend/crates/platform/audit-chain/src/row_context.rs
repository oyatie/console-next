//! All v2 context columns are sealed; v1 rows keep their original encoding.
use super::{
    AuditChainError,
    row::{canonical_json, lp},
};
use uuid::Uuid;
#[derive(Debug, Clone, sqlx::FromRow)]
pub(super) struct RowContext {
    pub row_hash_version: i16,
    pub source: Option<String>,
    pub change_mode: Option<String>,
    pub reason_code: Option<String>,
    pub decision_snapshot: Option<serde_json::Value>,
    pub command_id: Option<Uuid>,
    pub scope_ids: Option<Vec<Uuid>>,
    pub actor_kind: Option<String>,
    pub principal_type: Option<String>,
    pub session_id: Option<Uuid>,
    pub outcome: Option<String>,
    pub actor_display: Option<String>,
    pub actor_employer: Option<String>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub auth_method: Option<String>,
    pub device: Option<String>,
    pub classification_badges: Option<Vec<String>>,
    pub anomaly: Option<bool>,
    pub reason: Option<String>,
}
impl RowContext {
    pub fn append(&self, buf: &mut Vec<u8>) -> Result<(), AuditChainError> {
        // Option JSON encodes NULL distinctly from an empty array/string.
        for value in [
            serde_json::to_value(&self.source),
            serde_json::to_value(&self.change_mode),
            serde_json::to_value(&self.reason_code),
            serde_json::to_value(&self.decision_snapshot),
            serde_json::to_value(self.command_id),
            serde_json::to_value(&self.scope_ids),
            serde_json::to_value(&self.actor_kind),
            serde_json::to_value(&self.principal_type),
            serde_json::to_value(self.session_id),
            serde_json::to_value(&self.outcome),
            serde_json::to_value(&self.actor_display),
            serde_json::to_value(&self.actor_employer),
            serde_json::to_value(&self.ip),
            serde_json::to_value(&self.user_agent),
            serde_json::to_value(&self.auth_method),
            serde_json::to_value(&self.device),
            serde_json::to_value(&self.classification_badges),
            serde_json::to_value(self.anomaly),
            serde_json::to_value(&self.reason),
        ] {
            let value = value.map_err(|e| AuditChainError::Canonical(e.to_string()))?;
            lp(buf, &canonical_json(&Some(value))?);
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn legacy() -> Self {
        Self {
            row_hash_version: 1,
            source: None,
            change_mode: None,
            reason_code: None,
            decision_snapshot: None,
            command_id: None,
            scope_ids: None,
            actor_kind: None,
            principal_type: None,
            session_id: None,
            outcome: None,
            actor_display: None,
            actor_employer: None,
            ip: None,
            user_agent: None,
            auth_method: None,
            device: None,
            classification_badges: None,
            anomaly: None,
            reason: None,
        }
    }
}
