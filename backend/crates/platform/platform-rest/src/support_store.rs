// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::PlatformRestState;
use axum::response::IntoResponse;
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{
    AccessClaims, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind,
};
use console_platform_authz::access::{AccessSlice, NodePath, load_access_subject};
use console_platform_authz::cedar_pbac::actions::support_session::{
    self, Action, Facts, PrincipalKind,
};
use console_platform_db::support::{self, SupportError};
use console_settings_domain::{SettingKey, SettingValue};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

pub(super) fn limit(key: SettingKey) -> Result<Duration, SupportError> {
    match key.def().default {
        Some(SettingValue::Int(hours)) => Ok(Duration::hours(hours)),
        _ => Err(SupportError::Refused("internal")),
    }
}

pub(super) async fn tenant_permission(
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
    let accounts: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND is_active")
            .bind(org.as_uuid())
            .fetch_all(tx.as_mut())
            .await?;
    for account in accounts {
        if tenant_permission(tx, org, account).await? {
            return Ok(true);
        }
    }
    Ok(false)
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
    let sql = if vendor {
        "SELECT o.name||' · '||md5(u.id::text) FROM users u JOIN organizations o ON o.id=u.org_id WHERE u.id=$1 AND u.org_id=$2"
    } else {
        "SELECT display_name FROM users WHERE id=$1 AND org_id=$2"
    };
    Ok(sqlx::query_scalar(sql)
        .bind(user)
        .bind(org.as_uuid())
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
        Err(SupportError::Refused("forbidden"))
    }
}

pub(super) fn vendor_facts(other: i64, requester: bool) -> Facts {
    Facts {
        active: true,
        vendor: true,
        step_up: true,
        other_eligible_holders: other,
        actor_is_requester: requester,
        actor_holds_permission: true,
        ..Facts::default()
    }
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
