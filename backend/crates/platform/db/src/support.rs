// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant-owned support ledger and shared fail-closed audit writer.
use crate::{DbError, insert_audit_event};
use console_kernel_core::{
    ActorKind, AuditAction, AuditCommandContext, AuditEvent, OrgId, TraceContext, UserId,
};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum SupportError {
    #[error("{0}")]
    Refused(&'static str),
    #[error("support storage unavailable: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("support audit unavailable: {0}")]
    Audit(#[from] DbError),
}
impl SupportError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            _ => "internal",
        }
    }
    pub fn status(&self) -> u16 {
        match self.code() {
            "support.refuse.session_ended"
            | "support.refuse.session_expired"
            | "support.refuse.step_up_required" => 401,
            "support.refuse.read_only"
            | "support.refuse.out_of_scope"
            | "support.refuse.reveal_not_granted"
            | "support.refuse.requester_cannot_approve"
            | "forbidden" => 403,
            "validation" => 422,
            "not_found" => 404,
            "internal" => 500,
            _ => 409,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct Session {
    pub id: Uuid,
    pub org_id: Uuid,
    pub operator_ref: Uuid,
    pub operator_label: String,
    pub reason_code: String,
    pub scope: Vec<String>,
    pub state: String,
    pub masked: bool,
    pub reveal_classes: Vec<String>,
    pub requested_duration_seconds: i64,
    pub approved_duration_seconds: Option<i64>,
    #[serde(with = "time::serde::rfc3339")]
    pub requested_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub request_expires_at: OffsetDateTime,
    pub operator_approver_ref: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub tenant_approved_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
}

pub async fn arm(tx: &mut Transaction<'_, Postgres>, org: OrgId) -> Result<(), SupportError> {
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

pub async fn lock(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    id: Uuid,
) -> Result<Session, SupportError> {
    arm(tx, org).await?;
    sqlx::query_as("SELECT id,org_id,operator_ref,operator_label,reason_code,scope,state,masked,reveal_classes,requested_duration_seconds,approved_duration_seconds,requested_at,request_expires_at,operator_approver_ref,tenant_approved_at,expires_at FROM support_sessions WHERE org_id=$1 AND id=$2 FOR UPDATE")
        .bind(org.as_uuid()).bind(id).fetch_optional(tx.as_mut()).await?.ok_or(SupportError::Refused("not_found"))
}

pub fn live(session: &Session, now: OffsetDateTime) -> Result<(), SupportError> {
    if matches!(session.state.as_str(), "ENDED" | "REVOKED" | "DENIED") {
        return Err(SupportError::Refused("support.refuse.session_ended"));
    }
    if session.expires_at.is_some_and(|until| until <= now)
        || (session.state == "EXPIRED" && session.expires_at.is_some())
    {
        return Err(SupportError::Refused("support.refuse.session_expired"));
    }
    if session.state != "ACTIVE"
        && (session.request_expires_at <= now || session.state == "EXPIRED")
    {
        return Err(SupportError::Refused("support.refuse.request_expired"));
    }
    Ok(())
}

/// This is the only support audit writer. The explicit kind and label resolve a vendor with no tenant account.
#[allow(clippy::too_many_arguments)]
pub async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    id: Uuid,
    actor: Uuid,
    label: &str,
    vendor: bool,
    action: &str,
    details: Value,
    transport: Option<(TraceContext, console_kernel_core::AuditRequestContext)>,
) -> Result<(), SupportError> {
    let actor = (action != "support.expire").then(|| UserId::from_uuid(actor));
    let mut context = AuditCommandContext::for_actor(actor);
    context.org_id = Some(org);
    context.actor_kind = if actor.is_none() {
        ActorKind::System
    } else if vendor {
        ActorKind::SupportOperator
    } else {
        ActorKind::TenantUser
    };
    context.actor_display = Some(label.to_owned());
    context.session_id = Some(id);
    if details
        .get("status")
        .and_then(Value::as_u64)
        .is_some_and(|status| status >= 400)
    {
        context.outcome = console_kernel_core::AuditOutcome::Denied;
    }
    let mut event = AuditEvent::new(
        actor,
        AuditAction::new(action).map_err(|_| SupportError::Refused("internal"))?,
        "support_sessions",
        id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_command_context(context)
    .with_snapshots(None, Some(details));
    if let Some((trace, request)) = transport {
        event.trace = trace;
        event = event.with_request_context(request);
    }
    insert_audit_event(tx, &event).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn decision(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    id: Uuid,
    actor: Uuid,
    label: &str,
    vendor: bool,
    decision: &str,
) -> Result<(), SupportError> {
    sqlx::query("INSERT INTO support_session_decisions(org_id,session_id,actor_ref,actor_label,decision) VALUES($1,$2,$3,$4,$5)")
        .bind(org.as_uuid()).bind(id).bind(actor).bind(label).bind(decision).execute(tx.as_mut()).await?;
    let action = match decision {
        "REQUEST" => "support.request",
        "OPERATOR_APPROVE" => "support.operator_approve",
        "APPROVE" => "support.approve",
        "DENY" => "support.deny",
        "START" => "support.start",
        "END" => "support.end",
        _ => "support.expire",
    };
    audit(
        tx,
        org,
        id,
        actor,
        label,
        vendor,
        action,
        json!({"decision":decision}),
        None,
    )
    .await
}
