// SPDX-License-Identifier: LicenseRef-Proprietary
//! 7-day governed platform group join invitations (BG-12a).
#[path = "group_invitations_tenant.rs"]
mod tenant;

use crate::{PlatformProvisioner, ProvisioningError, fetch_org_tx};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_db::insert_audit_event;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

pub const GROUP_INVITATION_TTL_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupJoinInvitationSummary {
    pub id: Uuid,
    pub group_id: Uuid,
    pub group_slug: String,
    pub group_name: String,
    pub org_id: Uuid,
    pub org_slug: String,
    pub org_name: String,
    pub status: String,
    #[serde(with = "time::serde::rfc3339")]
    pub requested_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

pub(crate) fn invitation_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<GroupJoinInvitationSummary, ProvisioningError> {
    Ok(GroupJoinInvitationSummary {
        id: row.try_get("id")?,
        group_id: row.try_get("group_id")?,
        group_slug: row.try_get("group_slug")?,
        group_name: row.try_get("group_name")?,
        org_id: row.try_get("org_id")?,
        org_slug: row.try_get("org_slug")?,
        org_name: row.try_get("org_name")?,
        status: row.try_get("status")?,
        requested_at: row.try_get("requested_at")?,
        expires_at: row.try_get("expires_at")?,
    })
}

impl PlatformProvisioner {
    pub async fn create_group_join_invitation(
        &self,
        pool: &PgPool,
        actor: UserId,
        group_id: Uuid,
        org_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<GroupJoinInvitationSummary, ProvisioningError> {
        if org_id == *OrgId::platform().as_uuid() {
            return Err(ProvisioningError::NotFound("organization not found".into()));
        }
        let mut tx = pool.begin().await?;
        let group = super::rows::fetch_group_tx(&mut tx, group_id).await?;
        if group.status != "ACTIVE" {
            return Err(ProvisioningError::InvalidRoster(
                "group is not active".into(),
            ));
        }
        let org = fetch_org_tx(&mut tx, org_id).await?;
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org_id.to_string())
            .execute(tx.as_mut())
            .await?;

        sqlx::query(
            "UPDATE platform_group_join_requests
                SET status = 'CANCELLED', decided_at = $2
              WHERE org_id = $1 AND status = 'PENDING' AND expires_at <= $2",
        )
        .bind(org_id)
        .bind(now)
        .execute(tx.as_mut())
        .await?;

        let expires_at = now + Duration::days(GROUP_INVITATION_TTL_DAYS);
        let inserted: Option<Uuid> = sqlx::query_scalar(
            "INSERT INTO platform_group_join_requests (org_id, group_id, requested_by, requested_at, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING
             RETURNING id",
        )
        .bind(org_id)
        .bind(group_id)
        .bind(actor.as_uuid())
        .bind(now)
        .bind(expires_at)
        .fetch_optional(tx.as_mut())
        .await?;

        let Some(inv_id) = inserted else {
            return Err(ProvisioningError::Conflict(
                "organization already has a pending group join invitation".into(),
            ));
        };

        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("platform.group.invite_org")?,
            "platform_group_join_requests",
            inv_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id))
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "id": inv_id,
                "group_id": group_id,
                "org_id": org_id,
                "expires_at": expires_at,
            })),
        );
        insert_audit_event(&mut tx, &event).await?;
        tx.commit().await?;

        Ok(GroupJoinInvitationSummary {
            id: inv_id,
            group_id,
            group_slug: group.slug,
            group_name: group.name,
            org_id,
            org_slug: org.slug,
            org_name: org.name,
            status: "PENDING".into(),
            requested_at: now,
            expires_at,
        })
    }

    pub async fn cancel_group_join_invitation(
        &self,
        pool: &PgPool,
        actor: UserId,
        group_id: Uuid,
        invitation_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<(), ProvisioningError> {
        let mut tx = pool.begin().await?;
        let pending = sqlx::query(
            "SELECT id, org_id FROM platform_list_group_pending_invitations($1) WHERE id = $2",
        )
        .bind(group_id)
        .bind(invitation_id)
        .fetch_optional(tx.as_mut())
        .await?;
        let Some(row) = pending else {
            return Err(ProvisioningError::NotFound(
                "group join invitation not found".into(),
            ));
        };
        let org_id: Uuid = row.try_get("org_id")?;
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org_id.to_string())
            .execute(tx.as_mut())
            .await?;
        let updated = sqlx::query(
            "UPDATE platform_group_join_requests
                SET status = 'CANCELLED', decided_by = $3, decided_at = $4
              WHERE org_id = $1 AND id = $2 AND status = 'PENDING'",
        )
        .bind(org_id)
        .bind(invitation_id)
        .bind(actor.as_uuid())
        .bind(now)
        .execute(tx.as_mut())
        .await?;
        if updated.rows_affected() == 0 {
            return Err(ProvisioningError::NotFound(
                "group join invitation not found".into(),
            ));
        }
        let event = AuditEvent::new(
            Some(actor),
            AuditAction::new("platform.group.cancel_invite")?,
            "platform_group_join_requests",
            invitation_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(OrgId::from_uuid(org_id));
        insert_audit_event(&mut tx, &event).await?;
        tx.commit().await?;
        Ok(())
    }
}
