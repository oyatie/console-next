use crate::{
    BootstrapCredentialIssue, BootstrapCredentialStore, IssueMode, ProvisioningError,
    issue_bootstrap_if_needed_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::with_audits;
use sqlx::{PgPool, Postgres, Transaction};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

impl BootstrapCredentialStore {
    /// `actor` is the issuing admin, recorded on the `auth.bootstrap.issue`
    /// audit row; `None` only for system-initiated issuance.
    pub async fn issue_for_zero_credential_user(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        user_id: Uuid,
        org: OrgId,
        now: OffsetDateTime,
        ttl: Duration,
    ) -> Result<BootstrapCredentialIssue, ProvisioningError> {
        let store = self.clone();
        with_audits::<_, BootstrapCredentialIssue, ProvisioningError>(pool, org, move |tx| {
            Box::pin(async move {
                store
                    .issue_for_zero_credential_user_tx(tx, actor, user_id, org, now, ttl)
                    .await
            })
        })
        .await
    }

    /// The same issue on the caller's transaction; the caller persists returned audits.
    pub async fn issue_for_zero_credential_user_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        actor: Option<UserId>,
        user_id: Uuid,
        org: OrgId,
        now: OffsetDateTime,
        ttl: Duration,
    ) -> Result<(BootstrapCredentialIssue, Vec<AuditEvent>), ProvisioningError> {
        let hmac_key = self.resolve_hmac_key()?;
        // Admin-issued OTP path: the request's tenant `org` is threaded in
        // from the authenticated admin's verified token. The caller arms
        // `app.current_org`, so FORCE-RLS stamps and accepts the real org.
        let issue =
            issue_bootstrap_if_needed_tx(tx, &hmac_key, user_id, org, now, ttl, IssueMode::Reissue)
                .await?
                .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)?;
        let event = AuditEvent::new(
            actor,
            AuditAction::new("auth.bootstrap.issue")?,
            "auth_bootstrap_credential",
            user_id.to_string(),
            TraceContext::generate(),
            issue.expires_at - ttl,
        )
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "user_id": user_id,
                "credential_id": issue.credential_id,
                "expires_at": issue.expires_at,
            })),
        );
        Ok((issue, vec![event]))
    }
}
