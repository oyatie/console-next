// SPDX-License-Identifier: LicenseRef-Proprietary
//! Reissuing a platform operator invite token for a still-unkeyed operator.

use super::operators_store::*;
use crate::{
    PlatformOperatorInviteOutcome, PlatformOperatorStepUp, PlatformProvisioner, ProvisioningError,
    count_user_passkeys_tx, lock_open_bootstrap_tx, revoke_legacy_otp_families_for_sources_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_auth::authentication_time_tx;
use console_platform_authz::cedar_pbac::actions::platform_operator::{self, Action, Facts};
use console_platform_db::insert_audit_event;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

impl PlatformProvisioner {
    pub async fn reissue_platform_operator_invite_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: UserId,
        assertion: Uuid,
        target_user_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<PlatformOperatorInviteOutcome, ProvisioningError> {
        let payload_hash = PlatformOperatorStepUp::reissue_payload_hash(target_user_id)?;
        arm_platform_actor(tx, actor).await?;
        let (actor_locked, target_locked) =
            lock_platform_accounts_ordered(tx, *actor.as_uuid(), target_user_id).await?;
        let step_up =
            verify_operator_step_up(tx, actor, assertion, target_user_id, &payload_hash).await?;

        let Some((platform, active, roles, has_passkey)) = actor_authority_facts(tx, actor).await?
        else {
            return Err(ProvisioningError::PlatformOperator("unauthorized"));
        };
        let role_refs: Vec<&str> = roles.iter().map(String::as_str).collect();
        let platform_org = OrgId::platform().to_string();
        let (allowed, _) = platform_operator::decide(
            Action::Reissue,
            &actor.to_string(),
            &platform_org,
            &platform_org,
            &role_refs,
            Facts {
                platform,
                active: active && actor_locked == Some(true),
                step_up,
                has_passkey,
                actor_is_target: *actor.as_uuid() == target_user_id,
                other_active_enrolled: 0,
            },
        );
        if !allowed {
            return Err(ProvisioningError::PlatformOperator("forbidden"));
        }

        let platform_uuid = *OrgId::platform().as_uuid();
        let target_roles: Option<Vec<String>> =
            sqlx::query_scalar("SELECT roles FROM users WHERE org_id = $1 AND id = $2")
                .bind(platform_uuid)
                .bind(target_user_id)
                .fetch_optional(tx.as_mut())
                .await?;
        let Some(target_roles) = target_roles else {
            return Err(ProvisioningError::NotFound(
                "platform operator was not found".into(),
            ));
        };
        if !target_roles.iter().any(|r| r == "SUPER_ADMIN") {
            return Err(ProvisioningError::NotFound(
                "platform operator was not found".into(),
            ));
        }
        if target_locked != Some(true) {
            return Err(ProvisioningError::PlatformOperator(
                "operator_already_revoked",
            ));
        }
        if count_user_passkeys_tx(tx, target_user_id).await? > 0 {
            return Err(ProvisioningError::PlatformOperator(
                "operator_already_enrolled",
            ));
        }

        lock_open_bootstrap_tx(tx, target_user_id).await?;
        let now = authentication_time_tx(tx, now).await?;
        sqlx::query(
            "UPDATE platform_operator_invites \
             SET revoked_by = $1, revoked_at = $2, revoke_assertion_id = $3, revoke_reason = 'reissued' \
             WHERE org_id = $4 AND user_id = $5 AND accepted_at IS NULL AND revoked_at IS NULL",
        )
        .bind(actor.as_uuid())
        .bind(now)
        .bind(assertion)
        .bind(platform_uuid)
        .bind(target_user_id)
        .execute(tx.as_mut())
        .await?;

        let replaced: Vec<Uuid> = sqlx::query_scalar(
            "UPDATE auth_bootstrap_credentials \
             SET revoked_at = $1, revoked_reason = 'reissued' \
             WHERE user_id = $2 AND org_id = $3 AND consumed_at IS NULL AND revoked_at IS NULL \
             RETURNING id",
        )
        .bind(now)
        .bind(target_user_id)
        .bind(platform_uuid)
        .fetch_all(tx.as_mut())
        .await?;
        revoke_legacy_otp_families_for_sources_tx(
            tx,
            OrgId::platform(),
            target_user_id,
            &replaced,
            now,
        )
        .await?;

        let (invite_id, credential_id, invite_token, expires_at) = issue_invite_credential_tx(
            tx,
            actor,
            assertion,
            target_user_id,
            now,
            self.onboarding_otp_ttl,
        )
        .await?;

        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("platform.operator.reissue")?,
            "platform_operator",
            target_user_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::platform())
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_id": target_user_id,
                "invite_id": invite_id,
                "credential_id": credential_id,
                "expires_at": expires_at,
                "step_up_assertion_id": assertion,
            })),
        );
        insert_audit_event(tx, &event).await?;

        let operator = fetch_operator_summaries(tx, Some(target_user_id), now)
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
