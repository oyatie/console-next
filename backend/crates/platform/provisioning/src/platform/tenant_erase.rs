// SPDX-License-Identifier: LicenseRef-Proprietary
//! Erasure requests use the existing operator proof, settings and audit boundaries.
use super::ops_recovery_store::arm;
use crate::{
    OpsRecoveryActor, PlatformProvisioner, ProvisioningError, TenantEraseCommand as Command,
    TenantEraseRead, TenantEraseRequest,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_platform_db::{insert_audit_event, settings_read::resolve_in_tx};
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::{PgPool, Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

async fn cooling(
    tx: &mut Transaction<'_, Postgres>,
    now: OffsetDateTime,
) -> Result<i64, ProvisioningError> {
    let key = SettingKey::PlatformTenantEraseCooling;
    let values = resolve_in_tx(tx.as_mut(), OrgId::platform(), &[key], None, now).await?;
    match values
        .get(&key)
        .and_then(|r| r.as_ref().ok())
        .map(|r| r.value)
    {
        Some(SettingValue::Int(hours)) => Ok(hours),
        _ => Err(ProvisioningError::Conflict(
            "tenant erasure policy unavailable".into(),
        )),
    }
}
async fn operators(tx: &mut Transaction<'_, Postgres>) -> Result<i64, ProvisioningError> {
    Ok(sqlx::query_scalar("SELECT count(*) FROM person_accounts_current u WHERE org_id=$1 AND is_active AND 'SUPER_ADMIN'=ANY(roles) AND EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id)")
        .bind(OrgId::platform().as_uuid()).fetch_one(tx.as_mut()).await?)
}
async fn request(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
) -> Result<Option<TenantEraseRequest>, ProvisioningError> {
    Ok(sqlx::query_as("SELECT id,target_org_id,requested_by,opened_at,approved_by,cooling_until,cancelled_at,erased_at FROM tenant_erase_requests WHERE target_org_id=$1 ORDER BY opened_at DESC,id DESC LIMIT 1")
        .bind(org).fetch_optional(tx.as_mut()).await?)
}
impl PlatformProvisioner {
    pub async fn read_tenant_erase(
        &self,
        pool: &PgPool,
        org: Uuid,
        now: OffsetDateTime,
    ) -> Result<TenantEraseRead, ProvisioningError> {
        if org == *OrgId::platform().as_uuid() {
            return Err(ProvisioningError::NotFound("tenant".into()));
        }
        let mut tx = pool.begin().await?;
        let organization = crate::fetch_org_tx(&mut tx, org).await?;
        arm(&mut tx, OrgId::from_uuid(org)).await?;
        let legal_hold: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs_evidence_legal_holds WHERE org_id=$1 AND status='ACTIVE')").bind(org).fetch_one(tx.as_mut()).await?;
        arm(&mut tx, OrgId::platform()).await?;
        let read = TenantEraseRead {
            request: request(&mut tx, org).await?,
            second_operator_available: operators(&mut tx).await? >= 2,
            archived: organization.status == "ARCHIVED",
            legal_hold,
            cooling_hours: cooling(&mut tx, now).await?,
        };
        tx.commit().await?;
        Ok(read)
    }
    pub async fn write_tenant_erase_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: OpsRecoveryActor,
        org: Uuid,
        id: Uuid,
        command: Command,
    ) -> Result<TenantEraseRequest, ProvisioningError> {
        if actor.org != OrgId::platform() || org == *OrgId::platform().as_uuid() {
            return Err(ProvisioningError::TenantErase("unauthorized"));
        }
        arm(tx, OrgId::platform()).await?;
        let active = console_platform_auth::lock_account_tx(tx, actor.org, *actor.user.as_uuid())
            .await?
            == Some(true);
        let proof: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM step_up_assertions s JOIN person_accounts_current u ON u.id=s.user_id JOIN auth_webauthn_credentials c ON c.id=s.credential_row_id AND c.user_id=u.id WHERE s.ceremony_id=$1 AND s.org_id=$2 AND s.user_id=$3 AND s.action_kind='OPERATOR_RECOVERY' AND s.object_id=$4 AND s.payload_hash=$5 AND s.user_verified AND u.is_active AND 'SUPER_ADMIN'=ANY(u.roles))")
            .bind(actor.assertion).bind(actor.org.as_uuid()).bind(actor.user.as_uuid()).bind(id).bind(command.payload_hash(org,id)).fetch_one(tx.as_mut()).await?;
        if !active || !proof {
            return Err(ProvisioningError::TenantErase("unauthorized"));
        }
        let count = operators(tx).await?;
        sqlx::query("SELECT slug FROM platform_lock_organization($1)")
            .bind(org)
            .fetch_optional(tx.as_mut())
            .await?;
        let organization = crate::fetch_org_tx(tx, org).await?;
        arm(tx, OrgId::from_uuid(org)).await?;
        let held: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs_evidence_legal_holds WHERE org_id=$1 AND status='ACTIVE')").bind(org).fetch_one(tx.as_mut()).await?;
        arm(tx, OrgId::platform()).await?;
        let now: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(tx.as_mut())
            .await?;
        if !matches!(command, Command::Cancel) {
            if held {
                return Err(ProvisioningError::TenantErase("blocked_legal_hold"));
            }
            if organization.status != "ARCHIVED" {
                return Err(ProvisioningError::TenantErase("tenant_active"));
            }
            if count < 2 {
                return Err(ProvisioningError::TenantErase(
                    "erase_requires_second_operator",
                ));
            }
        }
        let current = request(tx, org).await?;
        match command {
            Command::Open => {
                if let Some(r) = &current
                    && r.cancelled_at.is_none()
                    && r.erased_at.is_none()
                {
                    if r.id == id {
                        return Ok(r.clone());
                    }
                    return Err(ProvisioningError::Conflict(
                        "tenant erasure request already open".into(),
                    ));
                }
                sqlx::query("INSERT INTO tenant_erase_requests(org_id,target_org_id,id,requested_by,opened_at,open_assertion) VALUES($1,$2,$3,$4,$5,$6)")
                    .bind(OrgId::platform().as_uuid()).bind(org).bind(id).bind(actor.user.as_uuid()).bind(now).bind(actor.assertion).execute(tx.as_mut()).await?;
            }
            Command::Approve | Command::Cancel => {
                let r = current
                    .filter(|r| r.id == id)
                    .ok_or_else(|| ProvisioningError::NotFound("tenant erasure request".into()))?;
                if r.cancelled_at.is_some() || r.erased_at.is_some() {
                    return Err(ProvisioningError::Conflict(
                        "tenant erasure request is closed".into(),
                    ));
                }
                if matches!(command, Command::Approve) {
                    if !console_platform_authz::cedar_pbac::actions::tenant_erase::approve(
                        &actor.user.to_string(),
                        &actor.org.to_string(),
                        &org.to_string(),
                        r.requested_by == *actor.user.as_uuid(),
                        true,
                        count - 1,
                    ) {
                        return Err(ProvisioningError::TenantErase("erase_same_operator"));
                    }
                    if r.approved_by.is_some() {
                        return Ok(r);
                    }
                    let open_assertion: Uuid = sqlx::query_scalar(
                        "SELECT open_assertion FROM tenant_erase_requests WHERE id=$1",
                    )
                    .bind(id)
                    .fetch_one(tx.as_mut())
                    .await?;
                    let shared: bool =
                        sqlx::query_scalar("SELECT step_up_shared_authenticator($1,$2)")
                            .bind(open_assertion)
                            .bind(actor.assertion)
                            .fetch_one(tx.as_mut())
                            .await?;
                    if shared {
                        return Err(ProvisioningError::TenantErase("erase_same_operator"));
                    }
                    let hours = cooling(tx, now).await?;
                    sqlx::query("UPDATE tenant_erase_requests SET approved_by=$2,approved_at=$3,cooling_until=$4,approve_assertion=$5 WHERE id=$1")
                        .bind(id).bind(actor.user.as_uuid()).bind(now).bind(now+Duration::hours(hours)).bind(actor.assertion).execute(tx.as_mut()).await?;
                } else {
                    sqlx::query("UPDATE tenant_erase_requests SET cancelled_by=$2,cancelled_at=$3 WHERE id=$1")
                        .bind(id).bind(actor.user.as_uuid()).bind(now).execute(tx.as_mut()).await?;
                }
            }
        }
        let event = AuditEvent::new(
            Some(actor.user),
            AuditAction::new(format!("platform.tenant.erase.{}", command.action()))?,
            "tenant_erase_request",
            id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::platform())
        .with_snapshots(
            None,
            Some(serde_json::json!({"target_org_id":org,"step_up_assertion_id":actor.assertion})),
        );
        insert_audit_event(tx, &event).await?;
        request(tx, org)
            .await?
            .ok_or_else(|| ProvisioningError::NotFound("tenant erasure request".into()))
    }
    /// The command-role worker claims and executes due requests atomically in the database.
    pub async fn run_due_tenant_erases(pool: &PgPool) -> Result<i64, ProvisioningError> {
        Ok(
            sqlx::query_scalar("SELECT platform_run_due_tenant_erases()")
                // rls-arming: ok isolated SECURITY DEFINER erase worker; pool grants only this control-plane command.
                .fetch_one(pool)
                .await?,
        )
    }
}
