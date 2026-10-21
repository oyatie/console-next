// SPDX-License-Identifier: LicenseRef-Proprietary
//! Request locks serialize decisions, notification and credential reset in one transaction.
use super::{ops_recovery_store::*, ops_recovery_types::*};
use crate::{
    BootstrapCredentialStore, OpsRecoveryState, PlatformProvisioner, ProvisioningError,
    recovery_state, require_issue,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_platform_authz::cedar_pbac::actions::ops_recovery_decide::{
    self as policy, Action, Facts,
};
use console_platform_db::{
    idempotency::{IdempotencyClaim, claim_idempotency_key, complete_idempotency_key},
    insert_audit_event,
};
use console_settings_domain::SettingKey;
use sqlx::{PgPool, Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;
impl PlatformProvisioner {
    #[allow(clippy::too_many_arguments)]
    pub async fn write_ops_recovery(
        &self,
        pool: &PgPool,
        actor: OpsRecoveryActor,
        org: OrgId,
        id: Uuid,
        command: OpsRecoveryCommand,
        key: &str,
        now: OffsetDateTime,
    ) -> Result<OpsRecoveryOutcome, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let outcome = self
            .write_ops_recovery_in_tx(&mut tx, actor, org, id, command, key, now)
            .await?;
        tx.commit().await?;
        Ok(outcome)
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn write_ops_recovery_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: OpsRecoveryActor,
        org: OrgId,
        id: Uuid,
        command: OpsRecoveryCommand,
        key: &str,
        now: OffsetDateTime,
    ) -> Result<OpsRecoveryOutcome, ProvisioningError> {
        if org == OrgId::platform() || (actor.org != OrgId::platform() && actor.org != org) {
            return Err(ProvisioningError::NotFound("recovery request".into()));
        }
        let vendor = actor.org == OrgId::platform();
        arm(tx, actor.org).await?;
        let active = console_platform_auth::lock_account_tx(tx, actor.org, *actor.user.as_uuid())
            .await?
            == Some(true);
        let proof:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM step_up_assertions WHERE ceremony_id=$1 AND user_id=$2 AND org_id=$3 AND action_kind='OPERATOR_RECOVERY' AND object_id=$4 AND payload_hash=$5 AND user_verified)")
            .bind(actor.assertion).bind(actor.user.as_uuid()).bind(actor.org.as_uuid()).bind(id).bind(command.payload_hash(org,id)?).fetch_one(tx.as_mut()).await?;
        if !proof || !active {
            return Err(ProvisioningError::OpsRecovery("unauthorized"));
        }
        let operators: i64 = if vendor {
            sqlx::query_scalar("SELECT count(*) FROM users u WHERE org_id=$1 AND is_active AND 'SUPER_ADMIN'=ANY(roles) AND EXISTS(SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id=u.id)").bind(actor.org.as_uuid()).fetch_one(tx.as_mut()).await?
        } else {
            0
        };
        arm(tx, org).await?;
        // Account custody precedes the organization lock, also when a tenant holder cancels.
        let ops: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops")
                .bind(org.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
        if let Some(ops) = ops {
            console_platform_auth::lock_account_tx(tx, org, ops).await?;
        }
        sqlx::query("SELECT slug FROM platform_lock_organization($1)")
            .bind(org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?;
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM organizations WHERE id=$1")
                .bind(org.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
        if status.is_none() {
            return Err(ProvisioningError::NotFound("tenant".into()));
        }
        let now = console_platform_auth::authentication_time_tx(tx, now).await?;
        let operation = format!("platform.tenant.ops_recovery.{}", command.action());
        let input = serde_json::json!({"actor":actor.user,"id":id,"command":command});
        match claim_idempotency_key(tx, &operation, key, &input).await? {
            IdempotencyClaim::Replay(body) => {
                let result: OpsRecoveryOutcome = serde_json::from_value(body)?;
                return Ok(result);
            }
            IdempotencyClaim::Mismatch => {
                return Err(ProvisioningError::Conflict("idempotency_key_reused".into()));
            }
            IdempotencyClaim::Fresh => {}
        }
        let mut outcome = OpsRecoveryOutcome {
            request_id: id,
            otp: None,
            expires_at: None,
        };
        let mut notified = 0;
        if let OpsRecoveryCommand::Open {
            authoriser_role,
            authoriser_name,
            proofing_method,
            evidence_ref,
        } = &command
        {
            if !vendor {
                return Err(ProvisioningError::OpsRecovery("forbidden"));
            }
            if status.as_deref() != Some("ACTIVE") {
                return Err(ProvisioningError::Conflict("tenant is not active".into()));
            }
            let target:Option<Uuid>=sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops AND is_active FOR NO KEY UPDATE").bind(org.as_uuid()).fetch_optional(tx.as_mut()).await?;
            let target = target.ok_or_else(|| ProvisioningError::NotFound("ops account".into()))?;
            let enrolled: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM auth_webauthn_credentials WHERE user_id=$1) OR EXISTS(SELECT 1 FROM ops_recovery_requests WHERE target_user_id=$1 AND issued_at IS NOT NULL)",
            )
            .bind(target)
            .fetch_one(tx.as_mut())
            .await?;
            if !enrolled {
                return Err(ProvisioningError::OpsRecovery("ops_recovery_not_enrolled"));
            }
            let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ops_recovery_requests WHERE org_id=$1 AND cancelled_at IS NULL AND issued_at IS NULL)").bind(org.as_uuid()).fetch_one(tx.as_mut()).await?;
            if exists {
                return Err(ProvisioningError::OpsRecovery("ops_recovery_already_open"));
            }
            if operators < 2 {
                return Err(ProvisioningError::OpsRecovery(
                    "ops_recovery_no_second_operator",
                ));
            }
            sqlx::query("INSERT INTO ops_recovery_requests(org_id,id,target_user_id,requested_by,opened_at,authoriser_role,authoriser_name,proofing_method,evidence_ref,open_assertion) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
                .bind(org.as_uuid()).bind(id).bind(target).bind(actor.user.as_uuid()).bind(now).bind(authoriser_role).bind(authoriser_name).bind(proofing_method).bind(evidence_ref).bind(actor.assertion).execute(tx.as_mut()).await.map_err(write_error)?;
            notified = notice(tx, org, "open").await?;
        } else {
            let row: OpsRecoveryRequest = sqlx::query_as("SELECT id,target_user_id,requested_by,opened_at,approved_by,hold_until,cancelled_by,cancelled_at,cancel_reason,issued_at,authoriser_role,authoriser_name,proofing_method,evidence_ref,open_assertion FROM ops_recovery_requests WHERE org_id=$1 AND id=$2 FOR UPDATE")
                .bind(org.as_uuid())
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| ProvisioningError::NotFound("recovery request".into()))?;
            let state = recovery_state(
                row.hold_until,
                row.cancelled_at.is_some(),
                row.issued_at.is_some(),
                now,
            );
            let action = match command {
                OpsRecoveryCommand::Approve => Action::Approve,
                OpsRecoveryCommand::Issue => Action::Issue,
                _ => Action::Cancel,
            };
            let allowed = policy::decide(
                action,
                &actor.user.to_string(),
                &actor.org.to_string(),
                &org.to_string(),
                Facts {
                    vendor,
                    active,
                    requester: row.requested_by == *actor.user.as_uuid(),
                    party: row.requested_by == *actor.user.as_uuid()
                        || row.approved_by == Some(*actor.user.as_uuid()),
                    during_hold: matches!(
                        state,
                        OpsRecoveryState::WaitingApproval | OpsRecoveryState::Hold
                    ),
                },
            );
            if !allowed {
                return Err(ProvisioningError::OpsRecovery(
                    if matches!(command, OpsRecoveryCommand::Approve) {
                        "ops_recovery_sod_requester"
                    } else {
                        "forbidden"
                    },
                ));
            }
            match &command {
                OpsRecoveryCommand::Approve => {
                    if state != OpsRecoveryState::WaitingApproval {
                        return Err(ProvisioningError::Conflict(
                            "recovery cannot be approved".into(),
                        ));
                    }
                    arm(tx, OrgId::platform()).await?;
                    let shared: bool =
                        sqlx::query_scalar("SELECT step_up_shared_authenticator($1,$2)")
                            .bind(row.open_assertion)
                            .bind(actor.assertion)
                            .fetch_one(tx.as_mut())
                            .await?;
                    arm(tx, org).await?;
                    if shared {
                        return Err(ProvisioningError::OpsRecovery(
                            "ops_recovery_shared_authenticator",
                        ));
                    }
                    sqlx::query("UPDATE ops_recovery_requests SET approved_by=$3,approved_at=$4,hold_until=$5,approve_assertion=$6 WHERE org_id=$1 AND id=$2")
                        .bind(org.as_uuid()).bind(id).bind(actor.user.as_uuid()).bind(now).bind(now+Duration::hours(setting(SettingKey::OpsRecoveryHoldHours)?)).bind(actor.assertion).execute(tx.as_mut()).await?;
                }
                OpsRecoveryCommand::Cancel { reason } => {
                    if matches!(
                        state,
                        OpsRecoveryState::Issued | OpsRecoveryState::Cancelled
                    ) {
                        return Err(ProvisioningError::OpsRecovery("ops_recovery_cancelled"));
                    }
                    sqlx::query("UPDATE ops_recovery_requests SET cancelled_by=$3,cancelled_at=$4,cancel_reason=$5 WHERE org_id=$1 AND id=$2").bind(org.as_uuid()).bind(id).bind(actor.user.as_uuid()).bind(now).bind(reason).execute(tx.as_mut()).await.map_err(write_error)?;
                    notified = notice(tx, org, "cancel").await?;
                }
                OpsRecoveryCommand::Issue => {
                    require_issue(state).map_err(|error| match error {
                        ProvisioningError::OpsRecovery("ops_recovery_hold_active") => {
                            ProvisioningError::OpsRecoveryHoldActive(row.hold_until)
                        }
                        other => other,
                    })?;
                    if status.as_deref() != Some("ACTIVE") {
                        return Err(ProvisioningError::Conflict("tenant is not active".into()));
                    }
                    let target:Option<Uuid>=sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops AND is_active FOR NO KEY UPDATE").bind(org.as_uuid()).fetch_optional(tx.as_mut()).await?;
                    if target != Some(row.target_user_id) {
                        return Err(ProvisioningError::Conflict("ops holder changed".into()));
                    }
                    let (issue, events) = BootstrapCredentialStore
                        .reset_credentials_for_user_tx(
                            tx,
                            actor.user,
                            row.target_user_id,
                            org,
                            now,
                            Duration::minutes(setting(SettingKey::OpsRecoveryCodeTtlMinutes)?),
                        )
                        .await?;
                    sqlx::query(
                        "UPDATE auth_bootstrap_credentials SET single_use=true WHERE id=$1",
                    )
                    .bind(issue.credential_id)
                    .execute(tx.as_mut())
                    .await?;
                    for event in events {
                        insert_audit_event(tx, &event).await?;
                    }
                    sqlx::query("UPDATE ops_recovery_requests SET issued_by=$3,issued_at=$4,code_credential_id=$5 WHERE org_id=$1 AND id=$2").bind(org.as_uuid()).bind(id).bind(actor.user.as_uuid()).bind(now).bind(issue.credential_id).execute(tx.as_mut()).await?;
                    notified = notice(tx, org, "issue").await?;
                    outcome.otp = Some(issue.token.as_str().to_owned());
                    outcome.expires_at = Some(issue.expires_at);
                }
                _ => {}
            }
        }
        let event=AuditEvent::new(Some(actor.user),AuditAction::new(&operation)?,"ops_recovery_request",id.to_string(),TraceContext::generate(),now).with_org(org)
            .with_snapshots(None,Some(serde_json::json!({"command":command,"step_up_assertion_id":actor.assertion,"notified_accounts":notified})));
        insert_audit_event(tx, &event).await?;
        // Never persist a replayable cleartext code. A retried issue returns only its receipt.
        let receipt = OpsRecoveryOutcome {
            request_id: id,
            otp: None,
            expires_at: outcome.expires_at,
        };
        complete_idempotency_key(tx, &operation, key, &serde_json::to_value(receipt)?).await?;

        Ok(outcome)
    }
}
