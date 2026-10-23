use crate::{
    GroupAccountOnboarding, GroupAccountSummary, IssueMode, PlatformProvisioner, ProvisioningError,
    VALID_GROUP_ROLES, VALID_ROLES, fetch_group_account_tx, fetch_group_tx, group_account_from_row,
    issue_bootstrap_if_needed_tx, map_group_write_error,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

impl PlatformProvisioner {
    /// List group-level account grants. Accounts remain homed in a concrete
    /// tenant org; group roles are cross-org grants layered on top.
    pub async fn list_group_accounts(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        group_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<Vec<GroupAccountSummary>, ProvisioningError> {
        let mut tx = pool.begin().await?;
        // Preserve 404 semantics: an empty grant list for an existing group is
        // different from a typoed group id.
        let _group = fetch_group_tx(&mut tx, group_id).await?;
        let rows = sqlx::query(
            r#"
            SELECT
                user_id, person_id, principal_kind, display_name, phone, tenant_roles, is_active,
                has_passkey, account_status, org_id, org_slug, org_name,
                group_roles, created_at
            FROM platform_list_group_person_accounts($1)
            "#,
        )
        .bind(group_id)
        .fetch_all(tx.as_mut())
        .await?;
        let accounts = rows
            .into_iter()
            .map(group_account_from_row)
            .collect::<Result<Vec<_>, _>>()?;

        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.group.accounts.list")?,
            "group_role_grants",
            group_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "group_id": group_id,
                "count": accounts.len(),
            })),
        );
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(accounts)
    }

    /// Create one tenant-anchored user account and grant a group role.
    ///
    /// The tenant role defaults to MEMBER at the REST layer. This method accepts
    /// an explicit role set so platform operators can intentionally make a user a
    /// tenant admin too; group authority remains stored in group_role_grants.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_group_account(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        group_id: Uuid,
        org_id: Uuid,
        display_name: &str,
        phone: Option<&str>,
        tenant_roles: &[String],
        group_role: &str,
        now: OffsetDateTime,
    ) -> Result<GroupAccountOnboarding, ProvisioningError> {
        let display_name = display_name.trim();
        if display_name.is_empty() {
            return Err(ProvisioningError::InvalidRoster(
                "display_name is required".to_owned(),
            ));
        }
        if tenant_roles.is_empty()
            || tenant_roles
                .iter()
                .any(|role| !VALID_ROLES.contains(&role.as_str()))
        {
            return Err(ProvisioningError::InvalidRoster(
                "tenant role is invalid".to_owned(),
            ));
        }
        if !VALID_GROUP_ROLES.contains(&group_role) {
            return Err(ProvisioningError::InvalidRoster(
                "group role is invalid".to_owned(),
            ));
        }
        let phone = phone.map(str::trim).filter(|value| !value.is_empty());
        let ttl = self.onboarding_otp_ttl;

        let mut tx = pool.begin().await?;
        let user_id: Option<Uuid> =
            sqlx::query_scalar("SELECT platform_create_group_account($1, $2, $3, $4, $5, $6, $7)")
                .bind(group_id)
                .bind(org_id)
                .bind(display_name)
                .bind(phone)
                .bind(tenant_roles)
                .bind(group_role)
                .bind(actor.map(|id| *id.as_uuid()))
                .fetch_one(tx.as_mut())
                .await
                .map_err(map_group_write_error)?;
        let Some(user_id) = user_id else {
            tx.rollback().await?;
            return Err(ProvisioningError::NotFound(
                "group or organization not found".to_owned(),
            ));
        };

        // platform_create_group_account arms app.current_org to org_id for this
        // transaction; keep it armed so the bootstrap credential passes FORCE RLS.
        let issue = issue_bootstrap_if_needed_tx(
            &mut tx,
            user_id,
            OrgId::from_uuid(org_id),
            now,
            ttl,
            IssueMode::RejectIfPresent,
        )
        .await?
        .ok_or(ProvisioningError::ActiveBootstrapCredentialExists)?;

        let account = fetch_group_account_tx(&mut tx, group_id, user_id).await?;

        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.group.account.create")?,
            "group_role_grants",
            format!("{group_id}:{user_id}:{group_role}"),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id))
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "group_id": group_id,
                "org_id": org_id,
                "user_id": user_id,
                "tenant_roles": tenant_roles,
                "group_role": group_role,
            })),
        );
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(GroupAccountOnboarding {
            account,
            otp: issue.token,
            otp_expires_at: issue.expires_at,
        })
    }

    /// Revoke one group role from a tenant-anchored account. The user row is not
    /// deleted; tenant admins can still manage/deactivate it from the tenant UI.
    pub async fn revoke_group_role(
        &self,
        pool: &PgPool,
        actor: Option<UserId>,
        group_id: Uuid,
        user_id: Uuid,
        group_role: &str,
        now: OffsetDateTime,
    ) -> Result<(), ProvisioningError> {
        if !VALID_GROUP_ROLES.contains(&group_role) {
            return Err(ProvisioningError::InvalidRoster(
                "group role is invalid".to_owned(),
            ));
        }
        let mut tx = pool.begin().await?;
        // Resolve the account through the group helper instead of reading
        // `users` directly under tenant RLS. This also gives us a stable target
        // org for the audit row before the grant is deleted.
        let account = fetch_group_account_tx(&mut tx, group_id, user_id).await?;
        let revoked: Option<Uuid> =
            sqlx::query_scalar("SELECT platform_revoke_group_role($1, $2, $3)")
                .bind(group_id)
                .bind(user_id)
                .bind(group_role)
                .fetch_one(tx.as_mut())
                .await
                .map_err(map_group_write_error)?;
        let Some(_revoked) = revoked else {
            tx.rollback().await?;
            return Err(ProvisioningError::NotFound(
                "group account role not found".to_owned(),
            ));
        };

        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(account.org_id.to_string())
            .execute(tx.as_mut())
            .await?;

        let event = AuditEvent::new(
            actor,
            AuditAction::new("platform.group.account.revoke")?,
            "group_role_grants",
            format!("{group_id}:{user_id}:{group_role}"),
            TraceContext::generate(),
            now,
        )
        .with_snapshots(
            Some(serde_json::json!({
                "group_id": group_id,
                "user_id": user_id,
                "group_role": group_role,
            })),
            None,
        )
        .with_org(OrgId::from_uuid(account.org_id));
        insert_audit_event(&mut tx, &event).await?;

        tx.commit().await?;
        Ok(())
    }
}
