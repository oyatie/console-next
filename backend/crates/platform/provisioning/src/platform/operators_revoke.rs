// SPDX-License-Identifier: LicenseRef-Proprietary
//! Revocation of platform operators, open invites, and live sessions.

use super::operators_store::*;
use crate::{
    PlatformOperatorStepUp, PlatformOperatorSummary, PlatformProvisioner, ProvisioningError,
    lock_open_bootstrap_tx, revoke_legacy_otp_families_for_sources_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_auth::authentication_time_tx;
use console_platform_authz::cedar_pbac::actions::platform_operator::{self, Action, Facts};
use console_platform_db::insert_audit_event;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

impl PlatformProvisioner {
    pub async fn revoke_platform_operator_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: UserId,
        assertion: Uuid,
        target_user_id: Uuid,
        reason: Option<&str>,
        now: OffsetDateTime,
    ) -> Result<PlatformOperatorSummary, ProvisioningError> {
        let trimmed_reason = reason.map(str::trim).filter(|s| !s.is_empty());
        if let Some(r) = trimmed_reason
            && r.chars().count() > 500
        {
            return Err(ProvisioningError::InvalidRoster(
                "reason must be at most 500 characters".to_owned(),
            ));
        }
        let payload_hash = PlatformOperatorStepUp::revoke_payload_hash(target_user_id, reason)?;

        arm_platform_actor(tx, actor).await?;
        let (actor_locked, target_locked) =
            lock_platform_accounts_ordered(tx, *actor.as_uuid(), target_user_id).await?;
        let step_up =
            verify_operator_step_up(tx, actor, assertion, target_user_id, &payload_hash).await?;

        let Some((platform, active, roles, has_passkey)) = actor_authority_facts(tx, actor).await?
        else {
            return Err(ProvisioningError::PlatformOperator("unauthorized"));
        };
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

        let other_active_enrolled = other_active_enrolled_count_tx(tx, target_user_id).await?;
        let role_refs: Vec<&str> = roles.iter().map(String::as_str).collect();
        let platform_org = OrgId::platform().to_string();
        let (allowed, reasons) = platform_operator::decide(
            Action::Revoke,
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
                other_active_enrolled,
            },
        );
        if !allowed {
            if reasons.iter().any(|r| r == "cannot_revoke_self") {
                return Err(ProvisioningError::PlatformOperator("cannot_revoke_self"));
            }
            if reasons.iter().any(|r| r == "last_platform_operator") {
                return Err(ProvisioningError::PlatformOperator(
                    "last_platform_operator",
                ));
            }
            return Err(ProvisioningError::PlatformOperator("forbidden"));
        }
        if target_locked != Some(true) {
            return Err(ProvisioningError::PlatformOperator(
                "operator_already_revoked",
            ));
        }

        lock_open_bootstrap_tx(tx, target_user_id).await?;
        let now = authentication_time_tx(tx, now).await?;
        sqlx::query("UPDATE users SET is_active = false WHERE org_id = $1 AND id = $2")
            .bind(platform_uuid)
            .bind(target_user_id)
            .execute(tx.as_mut())
            .await?;

        sqlx::query(
            "UPDATE platform_operator_invites \
             SET revoked_by = $1, revoked_at = $2, revoke_assertion_id = $3, revoke_reason = $4 \
             WHERE org_id = $5 AND user_id = $6 AND accepted_at IS NULL AND revoked_at IS NULL",
        )
        .bind(actor.as_uuid())
        .bind(now)
        .bind(assertion)
        .bind(trimmed_reason.unwrap_or("operator_revoked"))
        .bind(platform_uuid)
        .bind(target_user_id)
        .execute(tx.as_mut())
        .await?;

        let revoked_creds: Vec<Uuid> = sqlx::query_scalar(
            "UPDATE auth_bootstrap_credentials \
             SET revoked_at = $1, revoked_reason = 'operator_revoked' \
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
            &revoked_creds,
            now,
        )
        .await?;

        let revoked_families = sqlx::query(
            "UPDATE auth_refresh_token_families \
             SET revoked_at = $3, revoked_reason = 'operator_revoked' \
             WHERE user_id = $1 AND org_id = $2 AND revoked_at IS NULL",
        )
        .bind(target_user_id)
        .bind(platform_uuid)
        .bind(now)
        .execute(tx.as_mut())
        .await?
        .rows_affected();
        sqlx::query(
            "UPDATE auth_refresh_tokens \
             SET revoked_at = COALESCE(revoked_at, $3) \
             WHERE user_id = $1 AND org_id = $2",
        )
        .bind(target_user_id)
        .bind(platform_uuid)
        .bind(now)
        .execute(tx.as_mut())
        .await?;
        sqlx::query(
            "INSERT INTO subject_authz_versions (org_id, user_id, version, session_generation, updated_at) \
             VALUES ($1, $2, 1, 1, $3) \
             ON CONFLICT (org_id, user_id) DO UPDATE \
             SET session_generation = subject_authz_versions.session_generation + 1, \
                 updated_at = EXCLUDED.updated_at",
        )
        .bind(platform_uuid)
        .bind(target_user_id)
        .bind(now)
        .execute(tx.as_mut())
        .await?;

        let revoke_event = AuditEvent::new(
            Some(actor),
            AuditAction::new("platform.operator.revoke")?,
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
                "reason": trimmed_reason,
                "revoked_family_count": revoked_families,
                "step_up_assertion_id": assertion,
            })),
        );
        let session_event = AuditEvent::new(
            Some(actor),
            AuditAction::new("auth.refresh.revoke_all")?,
            "user",
            target_user_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::platform())
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_id": target_user_id,
                "reason": "operator_revoked",
                "revoked_family_count": revoked_families,
            })),
        );
        insert_audit_event(tx, &revoke_event).await?;
        insert_audit_event(tx, &session_event).await?;

        fetch_operator_summaries(tx, Some(target_user_id), now)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| ProvisioningError::NotFound("platform operator was not found".into()))
    }
}
