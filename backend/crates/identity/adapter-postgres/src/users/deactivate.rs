use crate::policy::versions::bump_subject_session_generation_tx;
use crate::users::rows::fetch_user_tx;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    DeactivateUserCommand, UserSummary, policy_account_audit_event, user_audit_event,
};
use console_kernel_core::{KernelError, OrgId, TraceContext, UserId};
use console_platform_authz::access::{CredentialSweep, sweep_credentials_tx};
use console_platform_db::with_audits;
use console_platform_request_context::current_org;
use sqlx::{Postgres, Transaction};

impl PgOrgStore {
    /// Soft-deactivate a user AND revoke every active credential + session.
    ///
    /// Offboarding must close all access in one atomic, audited transaction:
    /// flipping `is_active = false` only blocks NEW sign-ins, but a deactivated
    /// user keeps an enrolled passkey and any live refresh-token family until each
    /// naturally expires. So this also DELETEs every WebAuthn credential the user
    /// owns (their passkeys can no longer authenticate) and revokes every one of
    /// the user's refresh-token families + tokens (any live session dies on its
    /// next rotation, and refresh fails).
    ///
    /// The credential/session tables are FORCE-RLS, so the org GUC is armed for
    /// this transaction (via `with_audit` from `event.with_org(org)`) before the
    /// closure touches them. Each sub-action is independently audited.
    pub async fn deactivate_user(
        &self,
        command: DeactivateUserCommand,
    ) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let user_id = command.user_id;
        let actor = command.actor;
        let trace = command.trace.clone();
        let occurred_at = command.occurred_at;

        // One tenant-armed transaction decides between a real transition and a
        // no-op replay, and COMMITS the credential sweep in both cases. On a
        // no-op replay (already inactive) we still run the idempotent sweep so a
        // passkey/token that raced the original deactivation cannot survive
        // (console-cg6 review), then surface a Conflict to the caller without
        // minting a second transition row.
        let outcome = with_audits::<_, DeactivateOutcome, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                if console_platform_auth::lock_account_tx(tx, org, *user_id.as_uuid())
                    .await?
                    .is_none()
                {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                }
                let affected = sqlx::query(
                    "UPDATE users SET is_active = false WHERE id = $1 AND is_active = true",
                )
                .bind(*user_id.as_uuid())
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                if affected == 0 {
                    // Either the user is missing or already inactive.
                    let exists: Option<uuid::Uuid> =
                        sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
                            .bind(*user_id.as_uuid())
                            .fetch_optional(tx.as_mut())
                            .await?;
                    if exists.is_none() {
                        return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                    }
                    let sweep =
                        sweep_user_credentials_tx(tx, actor, user_id, &trace, occurred_at, org)
                            .await?;
                    return Ok((
                        DeactivateOutcome::AlreadyInactive,
                        vec![sweep.credential_event, sweep.session_event],
                    ));
                }

                // Real transition: sweep credentials + sessions, then record the
                // transition and the archive snapshot in the same transaction.
                let sweep =
                    sweep_user_credentials_tx(tx, actor, user_id, &trace, occurred_at, org).await?;
                let transition_event = user_audit_event(
                    "user.deactivate",
                    Some(actor),
                    user_id,
                    trace.clone(),
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({ "is_active": true })),
                    Some(serde_json::json!({ "is_active": false })),
                );
                let policy_event = policy_account_audit_event(
                    "policy.account.archive",
                    Some(actor),
                    user_id,
                    trace.clone(),
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({
                        "is_active": true,
                        "account_status": "ACTIVE"
                    })),
                    Some(serde_json::json!({
                        "is_active": false,
                        "account_status": "ARCHIVED",
                        "revoked_credential_count": sweep.revoked_credentials,
                        "revoked_family_count": sweep.revoked_families,
                    })),
                );

                // Offboarding revokes every credential + session; bump the
                // subject session_generation so any access token minted before
                // this point is recognizably stale to a later Cedar slice.
                bump_subject_session_generation_tx(
                    tx,
                    *org.as_uuid(),
                    *user_id.as_uuid(),
                    occurred_at,
                )
                .await?;

                let summary = fetch_user_tx(tx, user_id).await?;
                Ok((
                    DeactivateOutcome::Deactivated(Box::new(summary)),
                    vec![
                        sweep.credential_event,
                        sweep.session_event,
                        policy_event,
                        transition_event,
                    ],
                ))
            })
        })
        .await?;

        match outcome {
            DeactivateOutcome::Deactivated(summary) => Ok(*summary),
            DeactivateOutcome::AlreadyInactive => Err(PgOrgError::Domain(KernelError::conflict(
                "이미 보관된 사용자입니다.",
            ))),
        }
    }
}

/// The outcome of a user deactivation attempt: a real transition, or a no-op
/// replay of an already-inactive user. The no-op arm still commits a credential
/// sweep before the caller is told the transition was redundant.
enum DeactivateOutcome {
    Deactivated(Box<UserSummary>),
    AlreadyInactive,
}

/// Revoke every WebAuthn credential and refresh-token family/token for a user
/// inside an already-armed transaction (the platform sweep the exit shares).
/// Idempotent: the no-op replay path calls it to catch a credential that raced
/// the original deactivation (console-cg6 review).
async fn sweep_user_credentials_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    user_id: UserId,
    trace: &TraceContext,
    occurred_at: time::OffsetDateTime,
    org: OrgId,
) -> Result<CredentialSweep, PgOrgError> {
    Ok(sweep_credentials_tx(
        tx,
        org,
        actor,
        user_id,
        trace,
        occurred_at,
        "user_deactivated",
    )
    .await?)
}
