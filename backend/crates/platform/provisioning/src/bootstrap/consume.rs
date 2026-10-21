use crate::{
    BootstrapCredentialStore, ProvisioningError, lock_open_bootstrap_tx, require_active_account_tx,
};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext, UserId};
use console_platform_auth::authentication_time_tx;
use console_platform_db::insert_audit_event;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

impl BootstrapCredentialStore {
    /// Consume the user's open one-time code(s) inside the caller's transaction.
    ///
    /// Called by the legacy version-0 passkey registration path so its open code
    /// is consumed atomically with the passkey insert. Version-1 redemption
    /// consumes its exact source earlier, in the family/admission transaction.
    /// A returning user adding a second passkey has no open code (0 rows).
    pub async fn consume_open_credentials_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: OrgId,
        user_id: Uuid,
        now: OffsetDateTime,
    ) -> Result<(), ProvisioningError> {
        require_active_account_tx(tx, org, user_id).await?;
        lock_open_bootstrap_tx(tx, user_id).await?;
        let now = authentication_time_tx(tx, now).await?;
        let consumed = sqlx::query(
            r#"
            UPDATE auth_bootstrap_credentials
            SET consumed_at = $2
            WHERE user_id = $1
              AND consumed_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > $2
            RETURNING id
            "#,
        )
        .bind(user_id)
        .bind(now)
        .fetch_all(tx.as_mut())
        .await?;

        for row in consumed {
            let credential_id: Uuid = row.try_get("id")?;
            let audit = AuditEvent::new(
                Some(UserId::from_uuid(user_id)),
                AuditAction::new("auth.otp.consume")?,
                "auth_bootstrap_credential",
                credential_id.to_string(),
                TraceContext::generate(),
                now,
            )
            // Stamp the caller's org so this consume event is visible to a
            // tenant-scoped `/api/audit` read (RLS `USING (org_id = GUC)`). The
            // caller's tx already armed `app.current_org` to this org, so the
            // insert passes; a NULL org_id would pass WITH CHECK too but stay
            // invisible to the tenant.
            .with_org(org)
            .with_snapshots(None, Some(serde_json::json!({ "user_id": user_id })));
            insert_audit_event(tx, &audit).await?;
        }
        Ok(())
    }

    /// Complete a legacy registration with the exact OTP accepted at start.
    /// A later code cannot rescue a revoked, expired or consumed source.
    pub async fn consume_bound_credential_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: OrgId,
        user_id: Uuid,
        credential_id: Uuid,
        trusted_now: OffsetDateTime,
    ) -> Result<(), ProvisioningError> {
        require_active_account_tx(tx, org, user_id).await?;
        let source: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM auth_bootstrap_credentials \
             WHERE id=$1 AND user_id=$2 AND org_id=$3 AND issuance_version=0 FOR UPDATE",
        )
        .bind(credential_id)
        .bind(user_id)
        .bind(*org.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?;
        if source != Some(credential_id) {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }
        let now = authentication_time_tx(tx, trusted_now).await?;
        let consumed = sqlx::query(
            "UPDATE auth_bootstrap_credentials SET consumed_at=$1 \
             WHERE id=$2 AND user_id=$3 AND org_id=$4 AND issuance_version=0 \
               AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$1",
        )
        .bind(now)
        .bind(credential_id)
        .bind(user_id)
        .bind(*org.as_uuid())
        .execute(tx.as_mut())
        .await?;
        if consumed.rows_affected() != 1 {
            return Err(ProvisioningError::InvalidBootstrapCredential);
        }
        let audit = AuditEvent::new(
            Some(UserId::from_uuid(user_id)),
            AuditAction::new("auth.otp.consume")?,
            "auth_bootstrap_credential",
            credential_id.to_string(),
            TraceContext::generate(),
            now,
        )
        .with_org(org)
        .with_snapshots(None, Some(serde_json::json!({ "user_id": user_id })));
        insert_audit_event(tx, &audit).await?;
        Ok(())
    }
}
