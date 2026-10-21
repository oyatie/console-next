//! Trusted command context. A decision snapshot contains versions, never values.
use crate::{ChangeMode, OrgId, UserId};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuditSource {
    Form,
    Import,
    Scheduler,
    Api,
    System,
}
impl AuditSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Form => "FORM",
            Self::Import => "IMPORT",
            Self::Scheduler => "SCHEDULER",
            Self::Api => "API",
            Self::System => "SYSTEM",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ActorKind {
    TenantUser,
    OpsAccount,
    GroupAdmin,
    SupportOperator,
    System,
}
impl ActorKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TenantUser => "TENANT_USER",
            Self::OpsAccount => "OPS_ACCOUNT",
            Self::GroupAdmin => "GROUP_ADMIN",
            Self::SupportOperator => "SUPPORT_OPERATOR",
            Self::System => "SYSTEM",
        }
    }
    pub const fn principal_type(self) -> &'static str {
        match self {
            Self::OpsAccount => "TENANT_USER",
            _ => self.as_str(),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuditOutcome {
    Allowed,
    Denied,
}
impl AuditOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allowed => "ALLOWED",
            Self::Denied => "DENIED",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AuditCommandContext {
    #[serde(skip)]
    pub admission_captured: bool,
    pub org_id: Option<OrgId>,
    pub source: AuditSource,
    pub change_mode: Option<ChangeMode>,
    pub reason_code: Option<String>,
    pub decision_snapshot: BTreeMap<String, serde_json::Value>,
    pub command_id: Option<Uuid>,
    pub scope_ids: Vec<Uuid>,
    pub actor_kind: ActorKind,
    pub session_id: Option<Uuid>,
    pub outcome: AuditOutcome,
    pub actor_display: Option<String>,
    pub actor_employer: Option<String>,
}
impl AuditCommandContext {
    pub fn for_actor(actor: Option<UserId>) -> Self {
        Self {
            admission_captured: false,
            org_id: None,
            source: if actor.is_some() {
                AuditSource::Api
            } else {
                AuditSource::System
            },
            change_mode: None,
            reason_code: None,
            decision_snapshot: BTreeMap::new(),
            command_id: None,
            scope_ids: Vec::new(),
            actor_kind: if actor.is_some() {
                ActorKind::TenantUser
            } else {
                ActorKind::System
            },
            session_id: None,
            outcome: AuditOutcome::Allowed,
            actor_display: None,
            actor_employer: None,
        }
    }
}
