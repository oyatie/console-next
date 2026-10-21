use crate::policy::rows::fetch_policy_role;
use crate::policy::versions::fetch_subject_authz_versions_tx;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    PolicyAuditEventSummary, PolicyRoleSummary, PolicyVersionSummary,
};
use console_kernel_core::{KernelError, UserId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::Row;

impl PgOrgStore {
    /// List tenant-owned custom role definitions. Built-in system role templates
    /// are synthesized by the REST layer from the authz matrix; this adapter only
    /// reads tenant data under RLS.
    pub async fn list_policy_roles(&self) -> Result<Vec<PolicyRoleSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let ids: Vec<uuid::Uuid> = with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT id FROM policy_roles ORDER BY is_system DESC, role_key ASC",
                )
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;

        let mut roles = Vec::with_capacity(ids.len());
        for id in ids {
            roles.push(fetch_policy_role(&self.pool, id).await?);
        }
        Ok(roles)
    }

    /// Read the current per-org policy revision under RLS. Version 0 is a
    /// read-only projection for "no custom policy write yet" because
    /// `policy_versions` itself only stores real write revisions starting at 1.
    pub async fn get_policy_version(&self) -> Result<PolicyVersionSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT version, updated_at
                    FROM policy_versions
                    WHERE org_id = $1
                    "#,
                )
                .bind(org_uuid)
                .fetch_optional(tx.as_mut())
                .await?;

                let Some(row) = row else {
                    return Ok(PolicyVersionSummary {
                        version: 0,
                        updated_at: None,
                    });
                };
                Ok(PolicyVersionSummary {
                    version: row.try_get("version")?,
                    updated_at: Some(row.try_get("updated_at")?),
                })
            })
        })
        .await
    }

    /// Read the current subject authorization freshness `(version,
    /// session_generation)` for a user under RLS. An absent row (no bump yet)
    /// reads as `(0, 0)`, matching the token mint-time baseline. This is the
    /// DB-current side a later Cedar slice compares a token's carried snapshot
    /// against; SLICE-2 only sources it and no decision consults it yet.
    pub async fn get_subject_authz_versions(
        &self,
        user_id: UserId,
    ) -> Result<(i64, i64), PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let user_uuid = *user_id.as_uuid();
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move { fetch_subject_authz_versions_tx(tx, user_uuid).await })
        })
        .await
    }

    /// Resolve a per-tenant runtime feature flag via the `org_runtime_flag_enabled`
    /// SQL resolver (migration 0095) under the armed `console_rt` GUC. An absent row
    /// resolves to `false` (the dark default). Used by the Cedar/PBAC role_manage
    /// shadow lane's dark switch; a `false` result keeps the tenant fully on the
    /// legacy path (no shadow observation runs).
    pub async fn org_runtime_flag_enabled(&self, flag_key: &str) -> Result<bool, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let flag_key = flag_key.to_owned();
        with_org_conn::<_, bool, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let enabled: bool = sqlx::query_scalar("SELECT org_runtime_flag_enabled($1)")
                    .bind(flag_key)
                    .fetch_one(tx.as_mut())
                    .await?;
                Ok(enabled)
            })
        })
        .await
    }

    /// Return append-only policy audit evidence for the current tenant. This is
    /// read-only console evidence: it does not mutate policy and it never reads
    /// non-policy audit rows.
    pub async fn list_policy_audit_events(
        &self,
        limit: i64,
    ) -> Result<Vec<PolicyAuditEventSummary>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                    SELECT
                        id,
                        actor,
                        action,
                        target_type,
                        target_id,
                        before_snap,
                        after_snap,
                        trace_id::text AS trace_id,
                        span_id::text AS span_id,
                        occurred_at
                    FROM audit_events
                    WHERE org_id = $1
                      AND action LIKE 'policy.%'
                      AND target_type IN ('policy_role', 'policy_role_assignment', 'user')
                    ORDER BY occurred_at DESC, created_at DESC
                    LIMIT $2
                    "#,
                )
                .bind(org_uuid)
                .bind(limit)
                .fetch_all(tx.as_mut())
                .await?;

                rows.into_iter()
                    .map(|row| {
                        Ok(PolicyAuditEventSummary {
                            id: row.try_get("id")?,
                            actor: row
                                .try_get::<Option<uuid::Uuid>, _>("actor")?
                                .map(UserId::from_uuid),
                            action: row.try_get("action")?,
                            target_type: row.try_get("target_type")?,
                            target_id: row.try_get("target_id")?,
                            before_snapshot: row.try_get("before_snap")?,
                            after_snapshot: row.try_get("after_snap")?,
                            trace_id: row.try_get("trace_id")?,
                            span_id: row.try_get("span_id")?,
                            occurred_at: row.try_get("occurred_at")?,
                        })
                    })
                    .collect::<Result<Vec<_>, sqlx::Error>>()
                    .map_err(PgOrgError::from)
            })
        })
        .await
    }
}
