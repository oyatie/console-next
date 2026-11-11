// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant consent and visible access history. G2 can mount the pending-query source without another approval path.
use crate::{PlatformError, PlatformRestState, support_store as store};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use console_kernel_core::OrgId;
use console_platform_authz::{
    Principal,
    cedar_pbac::{actions::support_session::Action, visible::load_facts},
};
use console_platform_db::support::{self, SupportError};
use console_settings_domain::SettingKey;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

mod rows;

#[derive(Serialize)]
struct ActiveResponse {
    sessions: Vec<rows::Active>,
    can_approve: bool,
    pending_count: usize,
    pending_approvals: Vec<rows::Pending>,
}

#[derive(Serialize)]
struct HistoryResponse {
    sessions: Vec<rows::History>,
    can_approve: bool,
}

pub const TENANT_SUPPORT_SESSIONS_PATH: &str = "/api/v1/support-sessions";
pub const TENANT_SUPPORT_ACTIVE_PATH: &str = "/api/v1/support-sessions/active";
pub const TENANT_SUPPORT_DECISION_PATH: &str = "/api/v1/support-sessions/{id}/decision";
pub const TENANT_SUPPORT_END_PATH: &str = "/api/v1/support-sessions/{id}/end";

pub(crate) fn routes(router: Router<PlatformRestState>) -> Router<PlatformRestState> {
    router
        .route(TENANT_SUPPORT_SESSIONS_PATH, get(list))
        .route(TENANT_SUPPORT_ACTIVE_PATH, get(active))
        .route(TENANT_SUPPORT_DECISION_PATH, post(decide))
        .route(TENANT_SUPPORT_END_PATH, post(end))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecisionBody {
    decision: String,
    approved_duration_seconds: Option<i64>,
    #[serde(default)]
    reveal_classes: Vec<String>,
}

async fn active(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<Principal>,
) -> Result<Response, PlatformError> {
    let mut tx = state.pool.begin().await.map_err(SupportError::from)?;
    let permission =
        store::tenant_support_permission(&mut tx, p.org_id, *p.user_id.as_uuid()).await?;
    let rows = sqlx::query_as("SELECT id,operator_label,expires_at FROM support_sessions WHERE org_id=$1 AND state='ACTIVE' AND expires_at>clock_timestamp() ORDER BY requested_at")
        .bind(p.org_id.as_uuid()).fetch_all(tx.as_mut()).await.map_err(SupportError::from)?;
    let pending = if permission {
        sqlx::query_as("SELECT id,operator_label,ticket_ref,reason,request_expires_at FROM support_sessions WHERE org_id=$1 AND state='OPERATOR_APPROVED' AND tenant_approved_at IS NULL AND request_expires_at>clock_timestamp() ORDER BY request_expires_at,id")
            .bind(p.org_id.as_uuid()).fetch_all(tx.as_mut()).await.map_err(SupportError::from)?
    } else {
        Vec::new()
    };
    tx.commit().await.map_err(SupportError::from)?;
    Ok(Json(ActiveResponse {
        sessions: rows,
        can_approve: permission,
        pending_count: pending.len(),
        pending_approvals: pending,
    })
    .into_response())
}

async fn list(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<Principal>,
) -> Result<Response, PlatformError> {
    let mut tx = state.pool.begin().await.map_err(SupportError::from)?;
    let permission =
        store::tenant_support_permission(&mut tx, p.org_id, *p.user_id.as_uuid()).await?;
    if !permission {
        return Err(SupportError::Refused("forbidden").into());
    }
    let rows = rows::history(&mut tx, p.org_id.as_uuid()).await?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok(Json(HistoryResponse {
        sessions: rows,
        can_approve: true,
    })
    .into_response())
}

async fn decide(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<DecisionBody>,
) -> Result<Response, PlatformError> {
    let mut tx = state.pool.begin().await.map_err(SupportError::from)?;
    support::arm(&mut tx, p.org_id).await?;
    let facts = load_facts(&mut tx, p.org_id, *p.user_id.as_uuid())
        .await
        .map_err(|e| SupportError::Refused(e.kind.code()))?;
    let label = store::label(&mut tx, p.org_id, *p.user_id.as_uuid(), false).await?;
    let session = support::lock(&mut tx, p.org_id, id).await?;
    support::live(&session, OffsetDateTime::now_utc())?;
    store::require_support(
        Action::TenantApprove,
        p.user_id,
        p.org_id,
        p.org_id,
        facts
            .support_session(&mut tx, Some(id))
            .await
            .map_err(|_| SupportError::Refused("internal"))?,
    )?;
    if session.state != "OPERATOR_APPROVED" || session.tenant_approved_at.is_some() {
        return Err(SupportError::Refused("conflict").into());
    }
    if !matches!(body.decision.as_str(), "APPROVE" | "DENY")
        || body.reveal_classes.iter().any(|class| class != "personal")
    {
        return Err(PlatformError::validation(
            "invalid support decision or reveal class",
        ));
    }
    if body.decision == "APPROVE" {
        let seconds = body
            .approved_duration_seconds
            .ok_or(SupportError::Refused("validation"))?;
        if seconds <= 0
            || seconds > session.requested_duration_seconds
            || seconds
                > store::limit(&mut tx, p.org_id, SettingKey::SupportMaxDuration)
                    .await?
                    .whole_seconds()
        {
            return Err(SupportError::Refused("validation").into());
        }
        sqlx::query("UPDATE support_sessions SET tenant_approver_ref=$3,tenant_approved_at=now(),approved_duration_seconds=$4,reveal_classes=$5,masked=cardinality($5::text[])=0 WHERE org_id=$1 AND id=$2")
            .bind(p.org_id.as_uuid()).bind(id).bind(p.user_id.as_uuid()).bind(seconds).bind(&body.reveal_classes).execute(tx.as_mut()).await.map_err(SupportError::from)?;
    } else {
        sqlx::query(
            "UPDATE support_sessions SET state='DENIED',ended_at=now() WHERE org_id=$1 AND id=$2",
        )
        .bind(p.org_id.as_uuid())
        .bind(id)
        .execute(tx.as_mut())
        .await
        .map_err(SupportError::from)?;
    }
    support::decision(
        &mut tx,
        p.org_id,
        id,
        *p.user_id.as_uuid(),
        &label,
        false,
        &body.decision,
    )
    .await?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok(Json(json!({"id":id,"decision":body.decision})).into_response())
}

async fn end(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Response, PlatformError> {
    let mut tx = state.pool.begin().await.map_err(SupportError::from)?;
    support::arm(&mut tx, p.org_id).await?;
    let facts = load_facts(&mut tx, p.org_id, *p.user_id.as_uuid())
        .await
        .map_err(|e| SupportError::Refused(e.kind.code()))?;
    let label = store::label(&mut tx, p.org_id, *p.user_id.as_uuid(), false).await?;
    let _ = support::lock(&mut tx, p.org_id, id).await?;
    store::require_support(
        Action::End,
        p.user_id,
        p.org_id,
        p.org_id,
        facts
            .support_session(&mut tx, Some(id))
            .await
            .map_err(|_| SupportError::Refused("internal"))?,
    )?;
    sqlx::query("UPDATE support_sessions SET state='REVOKED',ended_at=now() WHERE org_id=$1 AND id=$2 AND state NOT IN ('ENDED','REVOKED','DENIED','EXPIRED')").bind(p.org_id.as_uuid()).bind(id).execute(tx.as_mut()).await.map_err(SupportError::from)?;
    support::decision(
        &mut tx,
        p.org_id,
        id,
        *p.user_id.as_uuid(),
        &label,
        false,
        "END",
    )
    .await?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok(Json(json!({"ended":true})).into_response())
}

/// Worker hook. Deadlines were resolved from registry keys when the request/session was approved.
pub async fn expire_support_sessions(pool: &sqlx::PgPool) -> Result<u64, SupportError> {
    let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
        // rls-arming: ok platform_list_organizations is a SECURITY DEFINER metadata listing; writes below are tenant-armed.
        .fetch_all(pool)
        .await?;
    let mut expired = 0;
    for org in orgs {
        let org = OrgId::from_uuid(org);
        let mut tx = pool.begin().await?;
        support::arm(&mut tx, org).await?;
        let ids:Vec<Uuid>=sqlx::query_scalar("UPDATE support_sessions SET state='EXPIRED',ended_at=clock_timestamp() WHERE org_id=$1 AND ((state IN ('REQUESTED','OPERATOR_APPROVED') AND request_expires_at<=clock_timestamp()) OR (state='ACTIVE' AND expires_at<=clock_timestamp())) RETURNING id")
            .bind(org.as_uuid()).fetch_all(tx.as_mut()).await?;
        for id in &ids {
            support::decision(&mut tx, org, *id, *org.as_uuid(), "시스템", false, "EXPIRE").await?;
        }
        tx.commit().await?;
        expired += ids.len() as u64;
    }
    Ok(expired)
}
