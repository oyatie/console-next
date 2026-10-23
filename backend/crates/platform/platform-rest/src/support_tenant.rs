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
    cedar_pbac::actions::support_session::{Action, Facts},
};
use console_platform_db::support::{self, SupportError};
use console_settings_domain::SettingKey;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

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
    let permission = store::tenant_permission(&mut tx, p.org_id, *p.user_id.as_uuid()).await?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'operator_label',operator_label,'expires_at',expires_at) FROM support_sessions WHERE org_id=$1 AND state='ACTIVE' AND expires_at>clock_timestamp() ORDER BY requested_at")
        .bind(p.org_id.as_uuid()).fetch_all(tx.as_mut()).await.map_err(SupportError::from)?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok(Json(json!({"sessions":rows,"can_approve":permission})).into_response())
}

async fn list(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<Principal>,
) -> Result<Response, PlatformError> {
    let mut tx = state.pool.begin().await.map_err(SupportError::from)?;
    let permission = store::tenant_permission(&mut tx, p.org_id, *p.user_id.as_uuid()).await?;
    if !permission {
        return Ok(Json(json!({"sessions":[],"can_approve":false})).into_response());
    }
    let rows:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(s)-'request_assertion'-'approval_assertion') || jsonb_build_object('decisions',COALESCE((SELECT jsonb_agg(jsonb_build_object('actor_label',d.actor_label,'decision',d.decision,'at',d.at) ORDER BY d.at,d.id) FROM support_session_decisions d WHERE d.org_id=s.org_id AND d.session_id=s.id),'[]'::jsonb),'records',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'method',a.after_snap->>'method','path',a.after_snap->>'path','at',a.occurred_at) ORDER BY a.occurred_at,a.id) FROM audit_events a WHERE a.org_id=s.org_id AND a.target_id=s.id::text AND a.action='support.access'),'[]'::jsonb)) FROM support_sessions s WHERE s.org_id=$1 ORDER BY s.requested_at DESC,s.id")
        .bind(p.org_id.as_uuid()).fetch_all(tx.as_mut()).await.map_err(SupportError::from)?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok(Json(json!({"sessions":rows,"can_approve":true})).into_response())
}

async fn decide(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
    Json(body): Json<DecisionBody>,
) -> Result<Response, PlatformError> {
    let mut tx = state.pool.begin().await.map_err(SupportError::from)?;
    let permission = store::tenant_permission(&mut tx, p.org_id, *p.user_id.as_uuid()).await?;
    let label = store::label(&mut tx, p.org_id, *p.user_id.as_uuid(), false).await?;
    let session = support::lock(&mut tx, p.org_id, id).await?;
    support::live(&session, OffsetDateTime::now_utc())?;
    store::authorize(
        Action::TenantApprove,
        p.user_id,
        p.org_id,
        p.org_id,
        Facts {
            active: true,
            actor_holds_permission: permission,
            operator_approved: session.operator_approver_ref.is_some(),
            ..Facts::default()
        },
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
            || seconds > store::limit(SettingKey::SupportMaxDuration)?.whole_seconds()
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
    let permission = store::tenant_permission(&mut tx, p.org_id, *p.user_id.as_uuid()).await?;
    let label = store::label(&mut tx, p.org_id, *p.user_id.as_uuid(), false).await?;
    let _ = support::lock(&mut tx, p.org_id, id).await?;
    store::authorize(
        Action::End,
        p.user_id,
        p.org_id,
        p.org_id,
        Facts {
            active: true,
            actor_holds_permission: permission,
            ..Facts::default()
        },
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
    // Sanctioned cross-tenant metadata listing; each subsequent write is tenant-armed.
    let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
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
