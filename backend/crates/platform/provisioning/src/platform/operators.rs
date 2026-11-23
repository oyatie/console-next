// SPDX-License-Identifier: LicenseRef-Proprietary
//! Platform second-operator invitation, listing, reissue, and revocation.

use super::operators_store::*;
use crate::{
    InvitePlatformOperatorInput, PlatformOperatorInviteOutcome, PlatformOperatorStepUp,
    PlatformOperatorSummary, PlatformProvisioner, ProvisioningError,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_auth::{authentication_time_tx, normalize_login};
use console_platform_authz::cedar_pbac::actions::platform_operator::{self, Action, Facts};
use console_platform_db::insert_audit_event;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

impl PlatformProvisioner {
    pub async fn list_platform_operators_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: UserId,
        now: OffsetDateTime,
    ) -> Result<Vec<PlatformOperatorSummary>, ProvisioningError> {
        arm_platform_actor(tx, actor).await?;
        let Some((platform, active, roles, has_passkey)) = actor_authority_facts(tx, actor).await?
        else {
            return Err(ProvisioningError::PlatformOperator("unauthorized"));
        };
        let role_refs: Vec<&str> = roles.iter().map(String::as_str).collect();
        let platform_org = OrgId::platform().to_string();
        let (allowed, _) = platform_operator::decide(
            Action::List,
            &actor.to_string(),
            &platform_org,
            &platform_org,
            &role_refs,
            Facts {
                platform,
                active,
                step_up: false,
                has_passkey,
                actor_is_target: false,
                other_active_enrolled: 0,
            },
        );
        if !allowed {
            return Err(ProvisioningError::PlatformOperator("forbidden"));
        }

        let now = authentication_time_tx(tx, now).await?;
        let operators = fetch_operator_summaries(tx, None, now).await?;
        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("platform.operator.list")?,
            "platform_operator",
            OrgId::platform().to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::platform())
        .with_snapshots(None, Some(serde_json::json!({ "count": operators.len() })));
        insert_audit_event(tx, &event).await?;
        Ok(operators)
    }

    pub async fn invite_platform_operator_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: UserId,
        assertion: Uuid,
        input: InvitePlatformOperatorInput,
        now: OffsetDateTime,
    ) -> Result<PlatformOperatorInviteOutcome, ProvisioningError> {
        let display_name = input.display_name.trim().to_owned();
        if display_name.is_empty() || display_name.chars().count() > 120 {
            return Err(ProvisioningError::InvalidRoster(
                "display_name must be 1 to 120 characters".to_owned(),
            ));
        }
        let normalized_login = match input
            .login
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(raw) => Some(normalize_login(raw).ok_or_else(|| {
                ProvisioningError::InvalidRoster(
                    "login must be 1 to 32 lowercase letters, digits, or single separators"
                        .to_owned(),
                )
            })?),
            None => None,
        };
        let payload_hash = PlatformOperatorStepUp::invite_payload_hash(
            input.id,
            &display_name,
            input.login.as_deref(),
        )?;

        arm_platform_actor(tx, actor).await?;
        let (actor_locked, _) =
            lock_platform_accounts_ordered(tx, *actor.as_uuid(), *actor.as_uuid()).await?;
        let step_up =
            verify_operator_step_up(tx, actor, assertion, input.id, &payload_hash).await?;
        let Some((platform, active, roles, has_passkey)) = actor_authority_facts(tx, actor).await?
        else {
            return Err(ProvisioningError::PlatformOperator("unauthorized"));
        };
        let role_refs: Vec<&str> = roles.iter().map(String::as_str).collect();
        let platform_org = OrgId::platform().to_string();
        let (allowed, _) = platform_operator::decide(
            Action::Invite,
            &actor.to_string(),
            &platform_org,
            &platform_org,
            &role_refs,
            Facts {
                platform,
                active: active && actor_locked == Some(true),
                step_up,
                has_passkey,
                actor_is_target: false,
                other_active_enrolled: 0,
            },
        );
        if !allowed {
            return Err(ProvisioningError::PlatformOperator("forbidden"));
        }

        let platform_uuid = *OrgId::platform().as_uuid();
        if let Some(ref login) = normalized_login {
            let taken: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM user_sign_in_ids WHERE org_id = $1 AND login = $2)",
            )
            .bind(platform_uuid)
            .bind(login)
            .fetch_one(tx.as_mut())
            .await?;
            if taken {
                return Err(ProvisioningError::PlatformOperator("login_taken"));
            }
        }

        sqlx::query(
            "INSERT INTO users (id, display_name, roles, is_active, org_id) \
             VALUES ($1, $2, ARRAY['SUPER_ADMIN']::TEXT[], true, $3)",
        )
        .bind(input.id)
        .bind(&display_name)
        .bind(platform_uuid)
        .execute(tx.as_mut())
        .await
        .map_err(|err| {
            if err.as_database_error().and_then(|db| db.code()).as_deref() == Some("23505") {
                ProvisioningError::PlatformOperator("operator_id_taken")
            } else {
                ProvisioningError::Sqlx(err)
            }
        })?;

        if let Some(ref login) = normalized_login {
            sqlx::query(
                "INSERT INTO user_sign_in_ids \
                 (org_id, login, user_id, effective_date, reason_code, assigned_by) \
                 VALUES ($1, $2, $3, (now() AT TIME ZONE 'Asia/Seoul')::date, 'INVITE', $4)",
            )
            .bind(platform_uuid)
            .bind(login)
            .bind(input.id)
            .bind(actor.as_uuid())
            .execute(tx.as_mut())
            .await
            .map_err(|err| {
                if err.as_database_error().and_then(|db| db.code()).as_deref() == Some("23505") {
                    ProvisioningError::PlatformOperator("login_taken")
                } else {
                    ProvisioningError::Sqlx(err)
                }
            })?;
        } else {
            sqlx::query("SET CONSTRAINTS trg_users_sign_in_id_default IMMEDIATE")
                .execute(tx.as_mut())
                .await?;
        }

        let now = authentication_time_tx(tx, now).await?;
        let (invite_id, credential_id, invite_token, expires_at) = issue_invite_credential_tx(
            tx,
            actor,
            assertion,
            input.id,
            now,
            self.onboarding_otp_ttl,
        )
        .await?;

        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("platform.operator.invite")?,
            "platform_operator",
            input.id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::platform())
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_id": input.id,
                "invite_id": invite_id,
                "credential_id": credential_id,
                "expires_at": expires_at,
                "step_up_assertion_id": assertion,
            })),
        );
        insert_audit_event(tx, &event).await?;

        let operator = fetch_operator_summaries(tx, Some(input.id), now)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| ProvisioningError::NotFound("platform operator was not found".into()))?;
        Ok(PlatformOperatorInviteOutcome {
            operator,
            invite_token,
            expires_at,
        })
    }
}
