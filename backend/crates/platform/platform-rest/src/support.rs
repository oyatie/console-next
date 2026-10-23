// SPDX-License-Identifier: LicenseRef-Proprietary
//! Operator requests carry no standing tenant authority. All transitions lock the tenant ledger.
use crate::{PlatformError, PlatformRestState, support_store as store};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use console_kernel_core::OrgId;
use console_platform_auth::{
    AccessClaims, AccessTokenInput, ActorSession, MobilePasskeyStepUpEnvelope,
};
use console_platform_authz::{PlatformPrincipal, cedar_pbac::actions::support_session::Action};
use console_platform_db::support::{self, SupportError};
use console_settings_domain::SettingKey;
use serde::Deserialize;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

pub const PLATFORM_SUPPORT_SESSIONS_PATH: &str = "/api/platform/support-sessions";
pub const PLATFORM_SUPPORT_APPROVE_PATH: &str = "/api/platform/support-sessions/{id}/approve";
pub const PLATFORM_SUPPORT_START_PATH: &str = "/api/platform/support-sessions/{id}/start";
pub const PLATFORM_SUPPORT_END_PATH: &str = "/api/platform/support-sessions/{id}/end";

pub(crate) fn routes(router: Router<PlatformRestState>) -> Router<PlatformRestState> {
    router
        .route(
            PLATFORM_SUPPORT_SESSIONS_PATH,
            get(store::list).post(request),
        )
        .route(PLATFORM_SUPPORT_APPROVE_PATH, post(approve))
        .route(PLATFORM_SUPPORT_START_PATH, post(start))
        .route(PLATFORM_SUPPORT_END_PATH, post(end))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestBody {
    id: Uuid,
    org_id: Uuid,
    ticket_ref: String,
    reason_code: String,
    reason: String,
    scope: Vec<String>,
    duration_seconds: i64,
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecisionBody {
    org_id: Uuid,
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}
#[derive(Deserialize)]
pub(super) struct Target {
    pub(super) org_id: Uuid,
}

async fn request(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Extension(claims): Extension<AccessClaims>,
    Json(body): Json<RequestBody>,
) -> Result<Response, PlatformError> {
    if body.ticket_ref.trim().is_empty()
        || body.reason_code.trim().is_empty()
        || body.reason.trim().is_empty()
        || body.duration_seconds <= 0
        || body.scope.is_empty()
    {
        return Err(PlatformError::validation(
            "ticket, reason, read scope and a positive duration are required",
        ));
    }
    let payload = json!([
        body.org_id,
        body.id,
        "request",
        body.ticket_ref,
        body.reason_code,
        body.reason,
        body.scope,
        body.duration_seconds
    ]);
    let (mut tx, assertion) =
        store::step_up(&state, &claims, body.id, payload, body.step_up).await?;
    let other = store::eligible(&mut tx, *p.user_id.as_uuid()).await?;
    if other == 0 {
        return Err(SupportError::Refused("support.refuse.no_second_operator").into());
    }
    let label = store::label(&mut tx, OrgId::platform(), *p.user_id.as_uuid(), true).await?;
    let org = OrgId::from_uuid(body.org_id);
    store::authorize(
        Action::Request,
        p.user_id,
        OrgId::platform(),
        org,
        store::vendor_facts(other, true),
    )?;
    support::arm(&mut tx, org).await?;
    let active: Option<bool> =
        sqlx::query_scalar("SELECT status='ACTIVE' FROM organizations WHERE id=$1")
            .bind(body.org_id)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(SupportError::from)?;
    if active != Some(true) {
        return Err(SupportError::Refused("not_found").into());
    }
    if !store::has_tenant_approver(&mut tx, org).await? {
        return Err(SupportError::Refused("support.refuse.no_tenant_approver").into());
    }
    let domains: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT domain FROM support_read_surfaces")
            .fetch_all(tx.as_mut())
            .await
            .map_err(SupportError::from)?;
    if body.scope.iter().any(|scope| !domains.contains(scope)) {
        return Err(SupportError::Refused("support.refuse.out_of_scope").into());
    }
    let now = OffsetDateTime::now_utc();
    let seconds = body
        .duration_seconds
        .min(store::limit(SettingKey::SupportMaxDuration)?.whole_seconds());
    let deadline = now + store::limit(SettingKey::SupportRequestExpiry)?;
    sqlx::query("INSERT INTO support_sessions(org_id,id,operator_ref,operator_label,ticket_ref,reason_code,reason,scope,requested_duration_seconds,requested_at,request_expires_at,request_assertion) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
        .bind(body.org_id).bind(body.id).bind(p.user_id.as_uuid()).bind(&label).bind(body.ticket_ref.trim()).bind(body.reason_code.trim()).bind(body.reason.trim()).bind(body.scope).bind(seconds).bind(now).bind(deadline).bind(assertion).execute(tx.as_mut()).await.map_err(SupportError::from)?;
    support::decision(
        &mut tx,
        org,
        body.id,
        *p.user_id.as_uuid(),
        &label,
        true,
        "REQUEST",
    )
    .await?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok((axum::http::StatusCode::CREATED,Json(json!({"id":body.id,"state":"REQUESTED","request_expires_at":deadline.format(&time::format_description::well_known::Rfc3339).map_err(|_|SupportError::Refused("internal"))?}))).into_response())
}

async fn approve(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Extension(claims): Extension<AccessClaims>,
    Path(id): Path<Uuid>,
    Json(body): Json<DecisionBody>,
) -> Result<Response, PlatformError> {
    let (mut tx, assertion) = store::step_up(
        &state,
        &claims,
        id,
        json!([body.org_id, id, "approve"]),
        body.step_up,
    )
    .await?;
    let other = store::eligible(&mut tx, *p.user_id.as_uuid()).await?;
    if other == 0 {
        return Err(SupportError::Refused("support.refuse.no_second_operator").into());
    }
    let label = store::label(&mut tx, OrgId::platform(), *p.user_id.as_uuid(), true).await?;
    let org = OrgId::from_uuid(body.org_id);
    let session = support::lock(&mut tx, org, id).await?;
    support::live(&session, OffsetDateTime::now_utc())?;
    if session.operator_ref == *p.user_id.as_uuid() {
        return Err(SupportError::Refused("support.refuse.requester_cannot_approve").into());
    }
    store::authorize(
        Action::OperatorApprove,
        p.user_id,
        OrgId::platform(),
        org,
        store::vendor_facts(other, false),
    )?;
    if session.state != "REQUESTED" {
        return Err(SupportError::Refused("conflict").into());
    }
    sqlx::query("UPDATE support_sessions SET operator_approver_ref=$3,operator_approved_at=now(),approval_assertion=$4,state='OPERATOR_APPROVED' WHERE org_id=$1 AND id=$2")
        .bind(body.org_id).bind(id).bind(p.user_id.as_uuid()).bind(assertion).execute(tx.as_mut()).await.map_err(SupportError::from)?;
    support::decision(
        &mut tx,
        org,
        id,
        *p.user_id.as_uuid(),
        &label,
        true,
        "OPERATOR_APPROVE",
    )
    .await?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok(Json(json!({"id":id,"state":"OPERATOR_APPROVED"})).into_response())
}

async fn start(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Extension(claims): Extension<AccessClaims>,
    Path(id): Path<Uuid>,
    Json(body): Json<DecisionBody>,
) -> Result<Response, PlatformError> {
    let (mut tx, _) = store::step_up(
        &state,
        &claims,
        id,
        json!([body.org_id, id, "start"]),
        body.step_up,
    )
    .await?;
    let other = store::eligible(&mut tx, *p.user_id.as_uuid()).await?;
    let org = OrgId::from_uuid(body.org_id);
    let session = support::lock(&mut tx, org, id).await?;
    support::live(&session, OffsetDateTime::now_utc())?;
    if session.tenant_approved_at.is_none() {
        return Err(SupportError::Refused("support.refuse.not_tenant_approved").into());
    }
    let mut facts = store::vendor_facts(other, session.operator_ref == *p.user_id.as_uuid());
    facts.operator_approved = session.operator_approver_ref.is_some();
    facts.tenant_approved = true;
    store::authorize(Action::Start, p.user_id, OrgId::platform(), org, facts)?;
    if session.state != "OPERATOR_APPROVED" {
        return Err(SupportError::Refused("conflict").into());
    }
    let now = OffsetDateTime::now_utc();
    let seconds = session
        .approved_duration_seconds
        .ok_or(SupportError::Refused("support.refuse.not_tenant_approved"))?
        .min(store::limit(SettingKey::SupportMaxDuration)?.whole_seconds());
    let expires_at = now + time::Duration::seconds(seconds);
    let issuer = state
        .support_issuer
        .as_ref()
        .ok_or(SupportError::Refused("internal"))?;
    let token = issuer
        .issue_support_access_token(
            AccessTokenInput {
                subject: p.user_id,
                org_id: org,
                roles: Vec::new(),
                branches: Vec::new(),
                platform: false,
                support: Some(id),
                read_only: true,
                display_name: Some(session.operator_label.clone()),
                feature_grants: Vec::new(),
                authz_subject_version: 0,
                authz_policy_version: 0,
                session_generation: 0,
                issued_at: now,
            },
            ActorSession {
                family_id: claims
                    .session_family_id
                    .ok_or(SupportError::Refused("support.refuse.session_ended"))?,
                // Consent owns the duration; live family checks still enforce logout and revocation.
                expires_at: expires_at.unix_timestamp(),
                home_org: OrgId::platform(),
                subject_version: claims.authz_subject_version,
                session_generation: claims.session_generation,
            },
            expires_at - now,
        )
        .map_err(|_| SupportError::Refused("internal"))?;
    sqlx::query("UPDATE support_sessions SET state='ACTIVE',started_at=$3,expires_at=$4 WHERE org_id=$1 AND id=$2").bind(body.org_id).bind(id).bind(now).bind(expires_at).execute(tx.as_mut()).await.map_err(SupportError::from)?;
    support::decision(
        &mut tx,
        org,
        id,
        *p.user_id.as_uuid(),
        &session.operator_label,
        true,
        "START",
    )
    .await?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok(Json(json!({"id":id,"access_token":token,"token_type":"Bearer","expires_at":expires_at.format(&time::format_description::well_known::Rfc3339).map_err(|_|SupportError::Refused("internal"))?})).into_response())
}

async fn end(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    Json(body): Json<Target>,
) -> Result<Response, PlatformError> {
    let mut tx = state.pool.begin().await.map_err(SupportError::from)?;
    let org = OrgId::from_uuid(body.org_id);
    let session = support::lock(&mut tx, org, id).await?;
    store::authorize(
        Action::End,
        p.user_id,
        OrgId::platform(),
        org,
        store::vendor_facts(0, session.operator_ref == *p.user_id.as_uuid()),
    )?;
    sqlx::query("UPDATE support_sessions SET state='ENDED',ended_at=now() WHERE org_id=$1 AND id=$2 AND state NOT IN ('ENDED','DENIED','REVOKED','EXPIRED')").bind(body.org_id).bind(id).execute(tx.as_mut()).await.map_err(SupportError::from)?;
    support::decision(
        &mut tx,
        org,
        id,
        *p.user_id.as_uuid(),
        &session.operator_label,
        true,
        "END",
    )
    .await?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok(Json(json!({"ended":true})).into_response())
}
