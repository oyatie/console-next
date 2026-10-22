// SPDX-License-Identifier: LicenseRef-Proprietary
use super::ops_recovery_types::*;
use crate::{PlatformProvisioner, ProvisioningError, recovery_state};
use console_kernel_core::OrgId;
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::{PgPool, Postgres, Transaction};
use time::OffsetDateTime;
pub(super) async fn arm(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
) -> Result<(), ProvisioningError> {
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await?;
    Ok(())
}
pub(super) fn setting(key: SettingKey) -> Result<i64, ProvisioningError> {
    match key.def().default {
        Some(SettingValue::Int(n)) => Ok(n),
        _ => Err(ProvisioningError::Conflict(
            "recovery policy unavailable".into(),
        )),
    }
}
pub(super) async fn notice(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    action: &str,
) -> Result<u64, ProvisioningError> {
    Ok(sqlx::query("INSERT INTO notifications(org_id,recipient_user_id,category,body,link) SELECT org_id,id,'tenant.ops_recovery',$2,jsonb_build_object('type','screen','screen','account') FROM users WHERE org_id=$1 AND is_active")
        .bind(org.as_uuid()).bind(crate::catalog::ops_recovery_notice(action)).execute(tx.as_mut()).await?.rows_affected())
}
pub(super) fn write_error(e: sqlx::Error) -> ProvisioningError {
    let constraint = e.as_database_error().and_then(|e| e.constraint());
    match constraint {
        Some("ops_recovery_evidence_identifier" | "ops_recovery_name_identifier") => {
            ProvisioningError::OpsRecovery("ops_recovery_evidence_identifier")
        }
        Some("ops_recovery_one_open") => {
            ProvisioningError::OpsRecovery("ops_recovery_already_open")
        }
        _ if e.as_database_error().and_then(|e| e.code()).as_deref() == Some("23514") => {
            ProvisioningError::InvalidRoster(
                "invalid recovery evidence or cancellation reason".into(),
            )
        }
        _ => ProvisioningError::Sqlx(e),
    }
}
// Reissue and recovery read the same ever-enrolled fact, including after credentials are reset.
pub(crate) async fn admin_enrolled_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: uuid::Uuid,
) -> Result<bool, ProvisioningError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (\
                 SELECT 1 FROM users u \
                 WHERE u.org_id = $1 AND 'SUPER_ADMIN' = ANY(u.roles) AND (\
                     EXISTS (SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id = u.id) \
                     OR EXISTS (SELECT 1 FROM audit_events a \
                                WHERE a.org_id = $1 AND a.action = 'auth.passkey.register' \
                                  AND a.actor = u.id)))",
    )
    .bind(org_id)
    .fetch_one(tx.as_mut())
    .await?)
}
impl PlatformProvisioner {
    pub async fn read_ops_recovery(
        &self,
        pool: &PgPool,
        org: OrgId,
        vendor: bool,
        now: OffsetDateTime,
    ) -> Result<OpsRecoveryRead, ProvisioningError> {
        let mut tx = pool.begin().await?;
        arm(&mut tx, OrgId::platform()).await?;
        let operators:i64=sqlx::query_scalar("SELECT count(*) FROM users u WHERE org_id=$1 AND is_active AND 'SUPER_ADMIN'=ANY(roles) AND EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id)").bind(OrgId::platform().as_uuid()).fetch_one(tx.as_mut()).await?;
        arm(&mut tx, org).await?;
        let mut request: Option<OpsRecoveryRequest> =
            sqlx::query_as("SELECT id,target_user_id,requested_by,opened_at,approved_by,hold_until,cancelled_by,cancelled_at,cancel_reason,issued_at,authoriser_role,authoriser_name,proofing_method,evidence_ref,open_assertion FROM ops_recovery_requests WHERE org_id=$1 ORDER BY opened_at DESC,id DESC LIMIT 1")
                .bind(org.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
        if let Some(r) = request.as_mut() {
            arm(&mut tx, OrgId::platform()).await?;
            r.requested_by_name = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
                .bind(r.requested_by)
                .fetch_optional(tx.as_mut())
                .await?;
            if let Some(user) = r.cancelled_by {
                r.cancelled_by_name =
                    sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
                        .bind(user)
                        .fetch_optional(tx.as_mut())
                        .await?;
                if r.cancelled_by_name.is_none() {
                    arm(&mut tx, org).await?;
                    r.cancelled_by_name =
                        sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
                            .bind(user)
                            .fetch_optional(tx.as_mut())
                            .await?;
                }
            }
            arm(&mut tx, org).await?;
        }
        let state = request.as_ref().map(|r| {
            recovery_state(
                r.hold_until,
                r.cancelled_at.is_some(),
                r.issued_at.is_some(),
                now,
            )
        });
        if !vendor && let Some(r) = request.as_mut() {
            r.authoriser_role = None;
            r.authoriser_name = None;
            r.proofing_method = None;
            r.evidence_ref = None;
        }
        let ops_has_passkey:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users u JOIN auth_webauthn_credentials c ON c.user_id=u.id WHERE u.org_id=$1 AND u.is_tenant_ops)").bind(org.as_uuid()).fetch_one(tx.as_mut()).await?;
        let recovery_available:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users u WHERE u.org_id=$1 AND u.is_tenant_ops AND (EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id) OR EXISTS(SELECT 1 FROM ops_recovery_requests r WHERE r.target_user_id=u.id AND r.issued_at IS NOT NULL)))").bind(org.as_uuid()).fetch_one(tx.as_mut()).await?;
        let ops_enrolled = admin_enrolled_tx(&mut tx, *org.as_uuid()).await?;
        let active_accounts: i64 =
            sqlx::query_scalar("SELECT count(*) FROM users WHERE org_id=$1 AND is_active")
                .bind(org.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
        tx.commit().await?;
        Ok(OpsRecoveryRead {
            request,
            state,
            ops_enrolled,
            ops_has_passkey,
            recovery_available,
            second_operator_available: operators >= 2,
            active_accounts,
            hold_hours: setting(SettingKey::OpsRecoveryHoldHours)?,
            code_ttl_minutes: setting(SettingKey::OpsRecoveryCodeTtlMinutes)?,
        })
    }
}
