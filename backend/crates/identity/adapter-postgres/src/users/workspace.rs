use crate::{PgOrgError, PgOrgStore};
use console_identity_application::user_audit_event;
use console_kernel_core::{KernelError, TraceContext, UserId};
use console_platform_db::{with_audit, with_org_conn};
use console_platform_request_context::current_org;

pub const CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY: &str = "console_legacy_kill_switch";

impl PgOrgStore {
    /// Read the caller's console workspace layout (Oyatie window engine, UI-M1b).
    ///
    /// The `layout` jsonb is OPAQUE to the backend — the frontend owns its shape
    /// and it is stored/returned verbatim. An absent row is the empty-default
    /// `{}` (a fresh user with no saved layout). Read under FORCE RLS for the
    /// armed org (`app.current_org` via `with_org_conn`) and with explicit
    /// `(org_id, user_id)` predicates supplied by the request tenant and the
    /// `/me` handler's authenticated principal.
    pub async fn get_workspace_layout(
        &self,
        user_id: UserId,
    ) -> Result<serde_json::Value, PgOrgError> {
        Ok(self.workspace_with_rollback(user_id).await?.0)
    }

    /// Read the saved preference and its tenant's emergency override in the same snapshot.
    pub async fn workspace_with_rollback(
        &self,
        user_id: UserId,
    ) -> Result<(serde_json::Value, bool), PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn(&self.pool, org, move |tx| Box::pin(async move {
            Ok(sqlx::query_as(
                "SELECT COALESCE((SELECT layout FROM me_workspace_layouts WHERE org_id=$1 AND user_id=$2), '{}'::jsonb),
                        org_runtime_flag_enabled($3)",
            )
            .bind(org.as_uuid())
            .bind(user_id.as_uuid())
            .bind(CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY)
            .fetch_one(tx.as_mut()).await?)
        })).await
    }

    /// Upsert the caller's console workspace layout. The write is audited (a
    /// `user.workspace_update` event lands in the SAME transaction, which also
    /// arms `app.current_org` for the FORCE-RLS `me_workspace_layouts` write).
    /// The stored `layout` is opaque and returned verbatim. The DB CHECKs
    /// (`jsonb_typeof = 'object'`, 64KiB size cap) are the final backstop for the
    /// user-writable blob.
    pub async fn put_workspace_layout(
        &self,
        user_id: UserId,
        layout: serde_json::Value,
        trace: TraceContext,
        occurred_at: console_kernel_core::Timestamp,
    ) -> Result<serde_json::Value, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let user_uuid = *user_id.as_uuid();

        let event = user_audit_event(
            "user.workspace_update",
            Some(user_id),
            user_id,
            trace,
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, serde_json::Value, PgOrgError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let stored: serde_json::Value = sqlx::query_scalar(
                    r#"
                    INSERT INTO me_workspace_layouts (org_id, user_id, layout)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (org_id, user_id)
                        DO UPDATE SET layout = EXCLUDED.layout
                    RETURNING layout
                    "#,
                )
                .bind(org_uuid)
                .bind(user_uuid)
                .bind(&layout)
                .fetch_one(tx.as_mut())
                .await?;
                Ok(stored)
            })
        })
        .await
    }
}
