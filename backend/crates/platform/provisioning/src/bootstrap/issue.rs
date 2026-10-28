use crate::{
    BootstrapCredentialIssue, BootstrapCredentialStore, IssueMode, ProvisioningError,
    issue_bootstrap_if_needed_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::with_audits;
use sqlx::PgPool;
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
        with_audits::<_, BootstrapCredentialIssue, ProvisioningError>(pool, org, |tx| {
            Box::pin(async move {
                // Admin-issued OTP path: the request's tenant `org` is threaded in
                // from the authenticated admin's verified token. `with_audits`
                // arms `app.current_org` to that org, so the FORCE-RLS WITH CHECK on
                // `auth_bootstrap_credentials` accepts the row for ANY tenant — not
                // just tenant #1 — and the credential is stamped with the real org.
                let issue =
                    issue_bootstrap_if_needed_tx(tx, user_id, org, now, ttl, IssueMode::Reissue)
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
            })
        })
        .await
    }

    /// Open self-service signup (#38): create a brand-new low-privilege user in
    /// the default (tenant #1) org and mint its first-sign-in OTP, ATOMICALLY and
    /// AUDITED. Unlike [`Self::issue_for_zero_credential_user`] (which needs a
    /// pre-provisioned user), this is the SIGNUP half: it makes the user row too.
    ///
    /// The new user gets the single lowest-privilege `MEMBER` role and no branch
    /// memberships, so it can authenticate but sees almost nothing until an admin
    /// elevates it (the authz matrix denies `MEMBER` everything but `Login`).
    /// `display_name` is the caller-supplied label (the email's local part); the
    /// email itself is only used out-of-band to deliver the returned OTP.
    ///
    /// In ONE transaction with `app.current_org` armed to tenant #1 by [`with_audits`],
    /// so the `users` + `auth_bootstrap_credentials` inserts pass the FORCE-RLS
    /// WITH CHECK as the non-owner `console_rt` role. Returns the one-time OTP exactly
    /// like the admin path; the OTP value is NEVER audited or logged.
    pub async fn signup_open_member(
        &self,
        pool: &PgPool,
        display_name: &str,
        now: OffsetDateTime,
        ttl: Duration,
    ) -> Result<BootstrapCredentialIssue, ProvisioningError> {
        let display_name = display_name.trim().to_owned();
        if display_name.is_empty() {
            return Err(ProvisioningError::InvalidRoster(
                "display name is required to sign up".to_owned(),
            ));
        }
        let org = OrgId::one();

        with_audits::<_, BootstrapCredentialIssue, ProvisioningError>(pool, org, |tx| {
            Box::pin(async move {
                // (1) Create the MEMBER user in tenant #1. The GUC armed by `with_audits`
                // scopes the insert to tenant #1 so it passes the FORCE-RLS WITH CHECK.
                let user_id: Uuid = sqlx::query_scalar(
                    r#"
                    INSERT INTO users (display_name, roles, is_active, org_id)
                    VALUES ($1, $2, true, $3)
                    RETURNING id
                    "#,
                )
                .bind(&display_name)
                .bind(&["MEMBER"] as &[&str])
                .bind(*org.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;

                // (2) Mint the first-sign-in OTP. The user has zero passkeys and no
                // open code, so RejectIfPresent always issues a fresh one.
                let issue = issue_bootstrap_if_needed_tx(
                    tx,
                    user_id,
                    org,
                    now,
                    ttl,
                    IssueMode::RejectIfPresent,
                )
                .await?
                .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)?;

                let event = AuditEvent::new(
                    Some(UserId::from_uuid(user_id)),
                    AuditAction::new("auth.signup")?,
                    "users",
                    user_id.to_string(),
                    TraceContext::generate(),
                    now,
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(serde_json::json!({
                        "user_id": user_id,
                        "role": "MEMBER",
                        "expires_at": issue.expires_at,
                    })),
                );

                Ok((issue, vec![event]))
            })
        })
        .await
    }
}
