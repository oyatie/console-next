use crate::policy::versions::bump_subject_version_tx;
use crate::users::rows::fetch_user_tx;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    ActivateUserCommand, UserSummary, policy_account_audit_event, user_audit_event,
};
use console_kernel_core::KernelError;
use console_platform_db::{insert_audit_event, with_audit};
use console_platform_request_context::current_org;

impl PgOrgStore {
    /// Reactivate an archived user. This reverses only the lifecycle flag; it
    /// never recreates passkeys or sessions, so an account with no credential
    /// returns as `PENDING_SETUP`.
    pub async fn activate_user(
        &self,
        command: ActivateUserCommand,
    ) -> Result<UserSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let user_id = command.user_id;
        let actor = command.actor;
        let occurred_at = command.occurred_at;
        let trace = command.trace.clone();
        let event = user_audit_event(
            "user.activate",
            Some(actor),
            user_id,
            trace.clone(),
            occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            Some(serde_json::json!({ "is_active": false })),
            Some(serde_json::json!({ "is_active": true })),
        );

        with_audit::<_, UserSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let affected = sqlx::query(
                    "UPDATE users SET is_active = true WHERE id = $1 AND is_active = false",
                )
                .bind(*user_id.as_uuid())
                .execute(tx.as_mut())
                .await?
                .rows_affected();
                if affected == 0 {
                    let exists: Option<uuid::Uuid> =
                        sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
                            .bind(*user_id.as_uuid())
                            .fetch_optional(tx.as_mut())
                            .await?;
                    if exists.is_none() {
                        return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                    }
                    // Already active: replaying activation is a no-op and must not
                    // bump the subject version or mint a second transition audit row
                    // (console-cg6). Return Conflict like the region/branch idempotence
                    // paths so `with_audit` rolls back before writing `user.activate`.
                    return Err(PgOrgError::Domain(KernelError::conflict(
                        "이미 활성화된 사용자입니다.",
                    )));
                }

                bump_subject_version_tx(tx, org_uuid, *user_id.as_uuid(), occurred_at).await?;
                let summary = fetch_user_tx(tx, user_id).await?;
                let policy_event = policy_account_audit_event(
                    "policy.account.activate",
                    Some(actor),
                    user_id,
                    trace,
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({
                        "is_active": false,
                        "account_status": "ARCHIVED"
                    })),
                    Some(serde_json::json!({
                        "is_active": true,
                        "account_status": summary.account_status,
                        "has_passkey": summary.has_passkey,
                    })),
                );
                insert_audit_event(tx, &policy_event).await?;
                Ok(summary)
            })
        })
        .await
    }
}
