//! Audit event type. Written append-only, in the SAME database transaction as
//! the state change it records (§2.2 of the plan). Carve-outs are the bound set
//! in `allowed_audit_exclusions()` (audit-coverage gate): LocationPing ingestion,
//! the location retention purge, and console route-telemetry ingestion
//! (ADR-0014 / ADR-0029 / ADR-0040). That gate function is the authority for the
//! set — do not restate a cardinality here.

mod command_context;
pub use command_context::{ActorKind, AuditCommandContext, AuditOutcome, AuditSource};

use crate::Timestamp;
use crate::error::KernelError;
use crate::ids::{AuditEventId, BranchId, OrgId, UserId};
use crate::trace::TraceContext;

/// Dot-namespaced action code, e.g. `work_order.approve`, `kpi.exclusion.revoke`.
///
/// Validated shape: two or more non-empty `[a-z0-9_]` segments joined by `.`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AuditAction(String);

impl AuditAction {
    pub fn new(value: impl Into<String>) -> Result<Self, KernelError> {
        let value: String = value.into();
        let segments: Vec<&str> = value.split('.').collect();
        let valid = segments.len() >= 2
            && segments.iter().all(|seg| {
                !seg.is_empty()
                    && seg
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            });
        if valid {
            Ok(Self(value))
        } else {
            Err(KernelError::validation(format!(
                "invalid audit action {value:?}: expected ≥2 dot-separated [a-z0-9_] segments"
            )))
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for AuditAction {
    type Error = KernelError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<AuditAction> for String {
    fn from(value: AuditAction) -> Self {
        value.0
    }
}

impl std::fmt::Display for AuditAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Nullable request context captured beside an audit event when available.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AuditRequestContext {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub auth_method: Option<String>,
    pub device: Option<String>,
}

/// Nullable classification metadata captured beside an audit event when available.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AuditClassification {
    pub badges: Option<Vec<String>>,
    pub anomaly: Option<bool>,
    pub reason: Option<String>,
}

/// One append-only audit record.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AuditEvent {
    pub id: AuditEventId,
    /// `None` = system-initiated (escalation timer, retention job, …).
    pub actor: Option<UserId>,
    pub action: AuditAction,
    /// Entity kind, e.g. `work_order`, `daily_plan`, `consent`.
    pub target_type: String,
    /// Stringified target ID (targets are heterogeneous).
    pub target_id: String,
    /// `None` = organization-global event (e.g. roster import).
    pub branch_id: Option<BranchId>,
    /// Owning tenant. When set, `with_audit` binds it to the `app.current_org`
    /// GUC for the audited transaction so Postgres RLS scopes the mutation.
    /// `None` keeps the legacy behavior (no tenant GUC set) for callers that
    /// have not yet been migrated to multi-tenancy.
    pub org_id: Option<OrgId>,
    /// State snapshot before the mutation, if meaningful.
    pub before: Option<serde_json::Value>,
    /// State snapshot after the mutation, if meaningful.
    pub after: Option<serde_json::Value>,
    #[serde(default)]
    pub request_context: AuditRequestContext,
    #[serde(default)]
    pub classification: AuditClassification,
    #[serde(default)]
    pub command_context: Option<AuditCommandContext>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

impl AuditEvent {
    /// Builder for the common case. Snapshots and branch attach via the
    /// `with_*` methods.
    #[must_use]
    pub fn new(
        actor: Option<UserId>,
        action: AuditAction,
        target_type: impl Into<String>,
        target_id: impl Into<String>,
        trace: TraceContext,
        occurred_at: Timestamp,
    ) -> Self {
        Self {
            id: AuditEventId::new(),
            actor,
            action,
            target_type: target_type.into(),
            target_id: target_id.into(),
            branch_id: None,
            org_id: None,
            before: None,
            after: None,
            request_context: AuditRequestContext::default(),
            classification: AuditClassification::default(),
            command_context: None,
            trace,
            occurred_at,
        }
    }

    #[must_use]
    pub fn with_source(mut self, source: AuditSource) -> Self {
        let context = self
            .command_context
            .get_or_insert_with(|| AuditCommandContext::for_actor(self.actor));
        context.source = source;
        if source == AuditSource::Scheduler {
            context.actor_kind = ActorKind::System;
        }
        self
    }

    pub fn with_command_context(mut self, context: AuditCommandContext) -> Self {
        self.command_context = Some(context);
        self
    }

    #[must_use]
    pub fn with_branch(mut self, branch: BranchId) -> Self {
        self.branch_id = Some(branch);
        self
    }

    /// Attach the owning tenant. `with_audit` binds this to the
    /// `app.current_org` GUC for the transaction so Postgres RLS scopes the
    /// audited mutation to that tenant.
    #[must_use]
    pub fn with_org(mut self, org: OrgId) -> Self {
        self.org_id = Some(org);
        self
    }

    #[must_use]
    pub fn with_snapshots(
        mut self,
        before: Option<serde_json::Value>,
        after: Option<serde_json::Value>,
    ) -> Self {
        self.before = before;
        self.after = after;
        self
    }

    #[must_use]
    pub fn with_request_context(mut self, context: AuditRequestContext) -> Self {
        self.request_context = context;
        self
    }

    #[must_use]
    pub fn with_classification(mut self, classification: AuditClassification) -> Self {
        self.classification = classification;
        self
    }
}

#[cfg(test)]
mod tests;
