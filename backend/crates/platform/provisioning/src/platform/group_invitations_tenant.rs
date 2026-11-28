// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{GroupJoinInvitationSummary, invitation_from_row};
use crate::{
    OrganizationSummary, PlatformProvisioner, ProvisioningError, fetch_org_tx,
    map_group_write_error,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

async fn begin_tenant_ops_tx(
    pool: &PgPool,
    actor: UserId,
    org: OrgId,
) -> Result<Transaction<'static, Postgres>, ProvisioningError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await?;
    console_platform_auth::lock_account_tx(&mut tx, org, *actor.as_uuid()).await?;
    let is_holder: Option<bool> = sqlx::query_scalar(
        "SELECT (u.is_tenant_ops OR EXISTS (
            SELECT 1 FROM ops_account_holders h
             WHERE h.org_id = u.org_id AND h.user_id = u.id AND h.released_at IS NULL
         )) AND u.is_active
           FROM users u WHERE u.id = $1 AND u.org_id = $2",
    )
    .bind(actor.as_uuid())
    .bind(org.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    if is_holder != Some(true) {
        return Err(ProvisioningError::Forbidden("ops_holder_only".to_owned()));
    }
    Ok(tx)
}

impl PlatformProvisioner {
    /// Check invitation authority before asking for a passkey. Release the account lock
    /// before WebAuthn takes it. Acceptance checks it again in the write transaction.
    pub async fn require_tenant_group_invitation_holder(
        &self,
        pool: &PgPool,
        actor: UserId,
        org: OrgId,
    ) -> Result<(), ProvisioningError> {
        begin_tenant_ops_tx(pool, actor, org)
            .await?
            .commit()
            .await?;
        Ok(())
    }

    pub async fn list_tenant_group_invitations(
        &self,
        pool: &PgPool,
        actor: UserId,
        org: OrgId,
    ) -> Result<Vec<GroupJoinInvitationSummary>, ProvisioningError> {
        let mut tx = begin_tenant_ops_tx(pool, actor, org).await?;
        let rows = sqlx::query("SELECT * FROM tenant_list_pending_group_invitations($1)")
            .bind(org.as_uuid())
            .fetch_all(tx.as_mut())
            .await?;
        let items = rows
            .into_iter()
            .map(invitation_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        tx.commit().await?;
        Ok(items)
    }

    pub async fn accept_tenant_group_invitation(
        &self,
        pool: &PgPool,
        actor: UserId,
        org: OrgId,
        invitation_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<OrganizationSummary, ProvisioningError> {
        let mut tx = begin_tenant_ops_tx(pool, actor, org).await?;
        let row = sqlx::query(
            "SELECT group_id FROM platform_group_join_requests
              WHERE org_id = $1 AND id = $2 AND status = 'PENDING' AND expires_at > $3
              FOR UPDATE",
        )
        .bind(org.as_uuid())
        .bind(invitation_id)
        .bind(now)
        .fetch_optional(tx.as_mut())
        .await?;
        let Some(row) = row else {
            return Err(ProvisioningError::NotFound(
                "pending group join invitation not found or expired".into(),
            ));
        };
        let group_id: Uuid = row.try_get("group_id")?;
        sqlx::query(
            "UPDATE platform_group_join_requests
                SET status = 'ACCEPTED', decided_by = $3, decided_at = $4
              WHERE org_id = $1 AND id = $2 AND status = 'PENDING'",
        )
        .bind(org.as_uuid())
        .bind(invitation_id)
        .bind(actor.as_uuid())
        .bind(now)
        .execute(tx.as_mut())
        .await?;
        let assigned: Option<Uuid> =
            sqlx::query_scalar("SELECT platform_assign_org_to_group($1, $2)")
                .bind(group_id)
                .bind(org.as_uuid())
                .fetch_one(tx.as_mut())
                .await
                .map_err(map_group_write_error)?;
        let Some(assigned_id) = assigned else {
            return Err(ProvisioningError::NotFound(
                "group or organization not found".into(),
            ));
        };
        let summary = fetch_org_tx(&mut tx, assigned_id).await?;
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await?;
        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("tenant.group_invitation.accept")?,
            "platform_group_join_requests",
            invitation_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({ "group_id": group_id, "org_id": org.as_uuid() })),
        );
        insert_audit_event(&mut tx, &event).await?;
        tx.commit().await?;
        Ok(summary)
    }

    pub async fn decline_tenant_group_invitation(
        &self,
        pool: &PgPool,
        actor: UserId,
        org: OrgId,
        invitation_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<(), ProvisioningError> {
        let mut tx = begin_tenant_ops_tx(pool, actor, org).await?;
        let updated = sqlx::query(
            "UPDATE platform_group_join_requests
                SET status = 'DECLINED', decided_by = $3, decided_at = $4
              WHERE org_id = $1 AND id = $2 AND status = 'PENDING' AND expires_at > $4",
        )
        .bind(org.as_uuid())
        .bind(invitation_id)
        .bind(actor.as_uuid())
        .bind(now)
        .execute(tx.as_mut())
        .await?;
        if updated.rows_affected() == 0 {
            return Err(ProvisioningError::NotFound(
                "pending group join invitation not found or expired".into(),
            ));
        }
        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("tenant.group_invitation.decline")?,
            "platform_group_join_requests",
            invitation_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(org);
        insert_audit_event(&mut tx, &event).await?;
        tx.commit().await?;
        Ok(())
    }
}
