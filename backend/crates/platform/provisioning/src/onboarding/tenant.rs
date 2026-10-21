use crate::{
    IssueMode, PlatformProvisioner, ProvisioningError, TenantAdminOtpReissue, TenantOnboarding,
    fetch_org_tx, issue_bootstrap_if_needed_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

impl PlatformProvisioner {
    /// Onboard a NEW tenant: create the `organizations` row, seed its first
    /// SUPER_ADMIN user (org_id = the new org), and issue a per-org cold-start
    /// OTP — all in ONE transaction, audited to the TARGET org so the action
    /// shows in both the platform and the tenant's audit trail.
    ///
    /// The org row is INSERTed via the SECURITY DEFINER `platform_create_organization`
    /// (migration 0036): `organizations` is SELECT-only + FORCE RLS for the app's
    /// `console_rt` role, so this is the ONLY path that can create an org. The function
    /// arms `app.current_org` to the new id, so the rest of the transaction (the
    /// admin user + the OTP credential, both stamped with the new org) passes the
    /// FORCE-RLS WITH CHECK on every tenant table as the non-owner role.
    pub async fn onboard_tenant(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        slug: &str,
        name: &str,
        now: OffsetDateTime,
    ) -> Result<TenantOnboarding, ProvisioningError> {
        let slug = slug.trim().to_owned();
        let name = name.trim().to_owned();
        if slug.is_empty() || name.is_empty() {
            return Err(ProvisioningError::InvalidRoster(
                "slug and name are required to onboard a tenant".to_owned(),
            ));
        }
        let ttl = self.onboarding_otp_ttl;

        let mut tx = pool.begin().await?;

        // (1) Create the org via the privileged DEFINER function. It arms the GUC
        // to the new id, so every subsequent tenant write in this tx passes RLS.
        let org_id: Uuid = sqlx::query_scalar("SELECT platform_create_organization($1, $2)")
            .bind(&slug)
            .bind(&name)
            .fetch_one(tx.as_mut())
            .await
            .map_err(crate::error::map_org_write_error)?;

        let organization = fetch_org_tx(&mut tx, org_id).await?;

        // (2) Seed the first administrator: the tenant's one ops account
        // (break-glass, decision #26; access-model §2.4).
        let admin_user_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO users (display_name, roles, is_active, org_id, is_tenant_ops)
            VALUES ($1, $2, true, $3, true)
            RETURNING id
            "#,
        )
        .bind("운영 계정")
        .bind(&["SUPER_ADMIN"] as &[&str])
        .bind(org_id)
        .fetch_one(tx.as_mut())
        .await?;

        // (3) Issue the per-org cold-start OTP for that admin. Fresh per-org —
        // never the removed fixed `coss0000` seed.
        let issue = issue_bootstrap_if_needed_tx(
            &mut tx,
            admin_user_id,
            OrgId::from_uuid(org_id),
            now,
            ttl,
            IssueMode::RejectIfPresent,
        )
        .await?
        .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)?;

        // (4) Audit the onboarding to the TARGET org (so it lands in the tenant's
        // trail too). The OTP value is NEVER recorded.
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.create")?,
            "organizations",
            org_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id))
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "org_id": org_id,
                "slug": slug,
                "admin_user_id": admin_user_id,
                "group_id": organization.group_id,
            })),
        );
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;

        Ok(TenantOnboarding {
            organization,
            admin_user_id,
            admin_otp: issue.token,
            admin_otp_expires_at: issue.expires_at,
        })
    }

    /// Reissue the cold-start OTP of a tenant's first active SUPER_ADMIN
    /// (earliest created) while the tenant is still onboarding — the recovery
    /// for a lost or expired onboarding code. Any still-open code is revoked
    /// (`reissued`) so the new one is the only valid code. Refused when the
    /// tenant is missing (`NotFound`) or not ACTIVE (`Conflict`), when it has
    /// no active SUPER_ADMIN (`NotFound`), and once ANY of its SUPER_ADMINs
    /// holds or ever registered a passkey (`UserAlreadyHasPasskey`): the tenant
    /// is then past onboarding and ops recovery requires the governed flow.
    /// Audited to the target org; the OTP never is.
    pub async fn reissue_tenant_admin_otp(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        org_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<TenantAdminOtpReissue, ProvisioningError> {
        let mut tx = pool.begin().await?;
        let organization = fetch_org_tx(&mut tx, org_id)
            .await
            .map_err(|error| match error {
                ProvisioningError::InvalidBootstrapCredential => {
                    ProvisioningError::NotFound("tenant was not found".to_owned())
                }
                other => other,
            })?;
        if organization.status != "ACTIVE" {
            return Err(ProvisioningError::Conflict(
                "tenant is not active".to_owned(),
            ));
        }
        // Arm the TARGET org: the admin read, the credential write, and the
        // audit row are all tenant rows under FORCE RLS.
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_id.to_string())
            .execute(tx.as_mut())
            .await?;
        // Past onboarding once any SUPER_ADMIN holds a passkey or ever
        // registered one (the register audit survives a later reset).
        let enrolled = crate::platform::admin_enrolled_tx(&mut tx, org_id).await?;
        if enrolled {
            return Err(ProvisioningError::UserAlreadyHasPasskey);
        }
        let admin_user_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM users WHERE org_id = $1 AND 'SUPER_ADMIN' = ANY(roles) AND is_active \
             ORDER BY created_at, id LIMIT 1",
        )
        .bind(org_id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            ProvisioningError::NotFound("tenant has no active SUPER_ADMIN account".to_owned())
        })?;
        let org = OrgId::from_uuid(org_id);
        let issue = issue_bootstrap_if_needed_tx(
            &mut tx,
            admin_user_id,
            org,
            now,
            self.onboarding_otp_ttl,
            IssueMode::Reissue,
        )
        .await
        .map_err(|error| match error {
            ProvisioningError::InvalidBootstrapCredential => {
                ProvisioningError::Conflict("tenant admin account is not active".to_owned())
            }
            other => other,
        })?
        .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)?;
        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.tenant.admin_otp.reissue")?,
            "organizations",
            org_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "org_id": org_id,
                "admin_user_id": admin_user_id,
                "expires_at": issue.expires_at,
            })),
        );
        insert_audit_event(&mut tx, &event).await?;
        tx.commit().await?;
        Ok(TenantAdminOtpReissue {
            admin_user_id,
            admin_otp: issue.token,
            admin_otp_expires_at: issue.expires_at,
        })
    }
}
