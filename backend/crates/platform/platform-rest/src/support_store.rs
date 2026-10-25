// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{PlatformError, PlatformRestState};
use axum::{
    Extension, Json,
    extract::{Path, State},
    response::{IntoResponse, Response},
};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{
    AccessClaims, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind,
};
use console_platform_authz::PlatformPrincipal;
use console_platform_authz::access::{AccessSlice, NodePath, load_access_subject};
use console_platform_authz::cedar_pbac::actions::support_session::{
    self, Action, Facts, PrincipalKind,
};
use console_platform_db::support::{self, SupportError};
use console_settings_domain::{SettingKey, SettingValue};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

pub(super) async fn limit(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    key: SettingKey,
) -> Result<Duration, SupportError> {
    support::arm(tx, org).await?;
    let resolved = console_platform_db::settings_read::resolve_in_tx(
        tx.as_mut(),
        org,
        &[key],
        None,
        OffsetDateTime::now_utc(),
    )
    .await
    .map_err(|_| SupportError::Refused("internal"))?;
    match resolved
        .get(&key)
        .and_then(|v| v.as_ref().ok())
        .map(|v| v.value)
    {
        Some(SettingValue::Int(hours)) => Ok(Duration::hours(hours)),
        _ => Err(SupportError::Refused("internal")),
    }
}

pub async fn tenant_permission(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    user: Uuid,
) -> Result<bool, SupportError> {
    support::arm(tx, org).await?;
    let subject = load_access_subject(tx, org, user, OffsetDateTime::now_utc())
        .await
        .map_err(|_| SupportError::Refused("internal"))?;
    AccessSlice::compile(&subject)
        .and_then(|slice| slice.allows("support_access::approve", &NodePath::tenant(org)))
        .map_err(|_| SupportError::Refused("internal"))
}

pub(super) async fn has_tenant_approver(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
) -> Result<bool, SupportError> {
    support::arm(tx, org).await?;
    // Only a tenant-wide enforced grant can approve a tenant-wide support session.
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users u WHERE u.org_id=$1 AND u.is_active AND (u.is_tenant_ops OR EXISTS(SELECT 1 FROM access_grants g JOIN access_roles r ON r.org_id=g.org_id AND r.id=g.role_id JOIN access_role_lines l ON l.org_id=r.org_id AND l.role_id=r.id AND l.version=r.version WHERE g.org_id=u.org_id AND g.account_id=u.id AND g.status='ACTIVE' AND r.status='ACTIVE' AND g.scope_kind='TENANT' AND g.include_descendants AND g.valid_from<=now() AND (g.valid_to IS NULL OR g.valid_to>now()) AND (COALESCE((SELECT phase FROM tenant_phase WHERE org_id=$1),'OPERATING')<>'SETUP' OR g.effective_in_setup) AND l.domain=$2 AND $3=ANY(l.levels))))")
        .bind(org.as_uuid()).bind(console_platform_authz::access::Domain::SupportAccess.as_str())
        .bind(console_platform_authz::access::Level::Approve.as_str()).fetch_one(tx.as_mut()).await?)
}

pub(super) async fn eligible(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
) -> Result<i64, SupportError> {
    support::arm(tx, OrgId::platform()).await?;
    let candidates:Vec<Vec<String>>=sqlx::query_scalar("SELECT u.roles FROM users u WHERE org_id=$1 AND u.id<>$2 AND u.is_active AND EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id AND c.passkey_json#>>'{cred,backup_eligible}'='false')")
        .bind(OrgId::platform().as_uuid()).bind(user).fetch_all(tx.as_mut()).await?;
    i64::try_from(
        candidates
            .iter()
            .filter(|roles| console_platform_authz::PlatformPrincipal::accepts_roles(roles))
            .count(),
    )
    .map_err(|_| SupportError::Refused("internal"))
}

pub(super) async fn label(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    user: Uuid,
    vendor: bool,
) -> Result<String, SupportError> {
    support::arm(tx, org).await?;
    Ok(sqlx::query_scalar(
        "SELECT COALESCE(NULLIF(btrim(u.display_name),''),s.login||'@'||o.slug) \
         || CASE WHEN $3 THEN ' · '||o.name ELSE '' END \
         FROM person_accounts_current u JOIN organizations o ON o.id=u.org_id \
         JOIN user_sign_in_ids s ON s.user_id=u.id AND s.org_id=u.org_id AND s.retired_at IS NULL \
         WHERE u.id=$1 AND u.org_id=$2",
    )
    .bind(user)
    .bind(org.as_uuid())
    .bind(vendor)
    .fetch_one(tx.as_mut())
    .await?)
}

pub(super) async fn step_up(
    state: &PlatformRestState,
    claims: &AccessClaims,
    id: Uuid,
    payload: Value,
    envelope: Option<MobilePasskeyStepUpEnvelope>,
) -> Result<(Transaction<'static, Postgres>, Uuid), SupportError> {
    let envelope = envelope.ok_or(SupportError::Refused("support.refuse.step_up_required"))?;
    let verifier = state
        .passkey_step_up
        .as_ref()
        .ok_or(SupportError::Refused("support.refuse.step_up_required"))?;
    let user = Uuid::parse_str(&claims.sub)
        .map_err(|_| SupportError::Refused("support.refuse.step_up_required"))?;
    let mut tx = state.pool.begin().await?;
    console_platform_request_context::validate_current_claims_in_tx(&mut tx, claims)
        .await
        .map_err(|_| SupportError::Refused("support.refuse.step_up_required"))?;
    let hash = Sha256::digest(
        serde_json::to_vec(&payload).map_err(|_| SupportError::Refused("validation"))?,
    )
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect();
    let expected = MobilePasskeyStepUpBinding {
        action_kind: MobileStepUpActionKind::SupportSession,
        object_id: id,
        reason_key: MobileStepUpActionKind::SupportSession
            .expected_reason_key()
            .into(),
        replay_attempt: None,
        payload_hash: Some(hash),
    };
    let assertion = verifier
        .verify_and_record_step_up_in_tx(&mut tx, envelope, user, &expected)
        .await
        .map_err(|_| SupportError::Refused("support.refuse.step_up_required"))?;
    let device_bound:bool=sqlx::query_scalar("SELECT c.passkey_json#>>'{cred,backup_eligible}'='false' FROM step_up_assertions a JOIN auth_webauthn_credentials c ON c.id=a.credential_row_id WHERE a.ceremony_id=$1")
        .bind(assertion).fetch_one(tx.as_mut()).await?;
    if !device_bound {
        return Err(SupportError::Refused("support.refuse.step_up_required"));
    }
    Ok((tx, assertion))
}

pub(super) fn authorize(
    action: Action,
    user: UserId,
    actor_org: OrgId,
    target: OrgId,
    facts: Facts,
) -> Result<(), SupportError> {
    let kind = if facts.vendor {
        PrincipalKind::Operator
    } else {
        PrincipalKind::Tenant
    };
    if support_session::decide(
        action,
        kind,
        &user.to_string(),
        &actor_org.to_string(),
        &target.to_string(),
        facts,
    ) {
        Ok(())
    } else {
        Err(SupportError::Refused(
            if action == Action::OperatorApprove && facts.actor_is_requester {
                "support.refuse.requester_cannot_approve"
            } else {
                "forbidden"
            },
        ))
    }
}

pub(super) async fn vendor_facts(
    tx: &mut Transaction<'_, Postgres>,
    user: UserId,
    requester: Uuid,
    other: i64,
    assertion: Option<Uuid>,
    session: Option<&support::Session>,
) -> Result<Facts, SupportError> {
    support::arm(tx, OrgId::platform()).await?;
    let (active, roles): (bool, Vec<String>) =
        sqlx::query_as("SELECT is_active,roles FROM users WHERE org_id=$1 AND id=$2")
            .bind(OrgId::platform().as_uuid())
            .bind(user.as_uuid())
            .fetch_one(tx.as_mut())
            .await?;
    if let Some(session) = session {
        support::arm(tx, OrgId::from_uuid(session.org_id)).await?;
    }
    Ok(Facts {
        active,
        vendor: console_platform_authz::PlatformPrincipal::accepts_roles(&roles),
        step_up: assertion.is_some(),
        other_eligible_holders: other,
        actor_is_requester: requester == *user.as_uuid(),
        actor_holds_permission: console_platform_authz::PlatformPrincipal::accepts_roles(&roles),
        operator_approved: session.is_some_and(|s| s.operator_approver_ref.is_some()),
        tenant_approved: session.is_some_and(|s| s.tenant_approved_at.is_some()),
        ..Facts::default()
    })
}

pub(super) async fn list(
    axum::extract::State(state): axum::extract::State<PlatformRestState>,
    axum::extract::Query(target): axum::extract::Query<super::support::Target>,
) -> Result<axum::response::Response, crate::PlatformError> {
    let mut tx = state.pool.begin().await.map_err(SupportError::from)?;
    support::arm(&mut tx, OrgId::from_uuid(target.org_id)).await?;
    // No ticket, stated reason, tenant identity, decisions or payload crosses back into the vendor tier.
    let rows:Vec<serde_json::Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'org_id',org_id,'operator_ref',operator_ref,'state',state,'requested_at',requested_at,'expires_at',expires_at) FROM support_sessions WHERE org_id=$1 ORDER BY requested_at DESC")
        .bind(target.org_id).fetch_all(tx.as_mut()).await.map_err(SupportError::from)?;
    tx.commit().await.map_err(SupportError::from)?;
    Ok(axum::Json(serde_json::json!({"sessions":rows})).into_response())
}

pub(super) async fn end(
    State(state): State<PlatformRestState>,
    Extension(p): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    Json(body): Json<super::support::Target>,
) -> Result<Response, PlatformError> {
    let mut tx = state.pool.begin().await.map_err(SupportError::from)?;
    let org = OrgId::from_uuid(body.org_id);
    let session = support::lock(&mut tx, org, id).await?;
    authorize(
        Action::End,
        p.user_id,
        OrgId::platform(),
        org,
        vendor_facts(
            &mut tx,
            p.user_id,
            session.operator_ref,
            0,
            None,
            Some(&session),
        )
        .await?,
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
