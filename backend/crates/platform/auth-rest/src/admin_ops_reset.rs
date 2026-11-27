// SPDX-License-Identifier: LicenseRef-Proprietary
//! Ops-holder peer credential reset: only an active ops holder may reset
//! another ops holder, and the fresh code is sent to the target's registered
//! `recovery_contacts` address — never returned on screen.

use axum::Json;
use console_kernel_core::{OrgId, UserId};
use console_platform_authz::Principal;
use console_platform_db::{DbError, with_audits, with_org_conn};
use console_platform_provisioning::ops_self_recovery::{
    ExposeSecret, RecoveryChannel, decrypt_recovery_contact_tx,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::dto::admin::{AdminCredentialResetRequest, AdminCredentialResetResponse};
use crate::error::RestError;
use crate::limits::DEFAULT_OTP_TTL;
use crate::rate_limit::passkey_error;
use crate::state::AuthRestState;

pub(crate) async fn target_is_ops_holder(
    state: &AuthRestState,
    org: OrgId,
    target: Uuid,
) -> Result<bool, RestError> {
    with_org_conn::<_, _, RestError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let is_ops: Option<bool> = sqlx::query_scalar(
                "SELECT is_tenant_ops AND is_active FROM users WHERE org_id = $1 AND id = $2",
            )
            .bind(org.as_uuid())
            .bind(target)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            Ok(is_ops == Some(true))
        })
    })
    .await
}

pub(crate) async fn reset_other_ops_holder(
    state: &AuthRestState,
    principal: &Principal,
    body: AdminCredentialResetRequest,
) -> Result<Json<AdminCredentialResetResponse>, RestError> {
    if !principal.is_tenant_ops {
        return Err(RestError {
            status: axum::http::StatusCode::FORBIDDEN,
            code: "ops_holder_only",
            message: "only an active ops account holder can reset another ops holder".to_owned(),
        });
    }
    let services = state.services()?;
    let step_up = body.step_up.ok_or_else(|| {
        RestError::unauthorized(
            "resetting credentials requires a step-up assertion of your passkey",
        )
    })?;
    services
        .passkeys
        .verify_step_up_for_user(
            &state.pool,
            step_up.ceremony_id,
            step_up.credential,
            *principal.user_id.as_uuid(),
        )
        .await
        .map_err(|err| passkey_error(err, "passkey step-up failed"))?;

    let org = principal.org_id;
    let actor: UserId = principal.user_id;
    let target = body.user_id;
    let bootstrap = services.bootstrap_credentials.clone();
    let cipher = services.recovery_cipher.clone();
    let now = OffsetDateTime::now_utc();
    let (issue, channel, dest, masked) =
        with_audits::<_, _, RestError>(&state.pool, org, move |tx| {
            Box::pin(async move {
                let caller_ops: Option<bool> = sqlx::query_scalar(
                    "SELECT is_tenant_ops AND is_active FROM users WHERE org_id = $1 AND id = $2 FOR SHARE",
                )
                .bind(org.as_uuid())
                .bind(actor.as_uuid())
                .fetch_optional(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                if caller_ops != Some(true) {
                    return Err(RestError {
                        status: axum::http::StatusCode::FORBIDDEN,
                        code: "ops_holder_only",
                        message: "only an active ops account holder can reset another ops holder"
                            .to_owned(),
                    });
                }
                let (channel, dest, masked) = decrypt_recovery_contact_tx(tx, &cipher, org, target)
                    .await
                    .map_err(RestError::from_provisioning)?
                    .ok_or_else(|| RestError {
                        status: axum::http::StatusCode::CONFLICT,
                        code: "ops_recovery_contact_missing",
                        message: "the target ops holder has no registered recovery contact"
                            .to_owned(),
                    })?;
                let (issue, events) = bootstrap
                    .reset_credentials_for_user_tx(tx, actor, target, org, now, DEFAULT_OTP_TTL)
                    .await
                    .map_err(RestError::from_provisioning)?;
                Ok(((issue, channel, dest, masked), events))
            })
        })
        .await?;

    if channel == RecoveryChannel::Email && services.email_sender.can_send() {
        let _ = services
            .email_sender
            .send_otp(
                dest.expose_secret(),
                issue.token.as_str(),
                std::time::Duration::from_secs(
                    u64::try_from(DEFAULT_OTP_TTL.whole_seconds()).unwrap_or(14_400),
                ),
            )
            .await;
    }

    Ok(Json(AdminCredentialResetResponse {
        user_id: issue.user_id,
        otp: String::new(),
        expires_at: issue.expires_at,
        delivered_to_recovery_contact: true,
        masked_contact: Some(masked),
    }))
}
