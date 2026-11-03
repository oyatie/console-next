// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{IdempotentCreate, PgOrgError, PgOrgStore};
use console_identity_application::EmployeeView;
use console_identity_domain::validate_org_name;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_platform_authz::cedar_pbac::visible::load_facts;
use console_platform_db::{DbError, command_outcomes, with_audits, with_org_conn};
use console_platform_request_context::current_org;
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::{SettingKey, SettingValue};
use serde_json::Value;
use uuid::Uuid;

async fn require_owner(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    actor: UserId,
    owner: Uuid,
) -> Result<(), PgOrgError> {
    let facts = load_facts(tx, org, *actor.as_uuid()).await?;
    if !facts
        .authorize_employee_view(org, owner)
        .map_err(|_| KernelError::unavailable("employee-view Cedar decision unavailable"))?
    {
        return Err(
            KernelError::forbidden("employee view belongs to another account")
                .with_code("employee_view_owner_required")
                .into(),
        );
    }
    Ok(())
}

impl PgOrgStore {
    pub async fn employee_views(&self, actor: UserId) -> Result<Vec<Value>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn(&self.pool, org, |tx| Box::pin(async move {
            require_owner(tx, org, actor, *actor.as_uuid()).await?;
            Ok(sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'filters',filters) FROM employee_views WHERE org_id=$1 AND user_id=$2 ORDER BY name,id")
                .bind(org.as_uuid()).bind(actor.as_uuid()).fetch_all(tx.as_mut()).await?)
        })).await
    }

    pub async fn create_employee_view(
        &self,
        actor: UserId,
        mut view: EmployeeView,
    ) -> Result<IdempotentCreate, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        view.name = validate_org_name(&view.name)?;
        for value in [
            &view.filters.status,
            &view.filters.review,
            &view.filters.unit,
            &view.filters.sort,
        ]
        .into_iter()
        .flatten()
        {
            validate_org_name(value)?;
        }
        let request = serde_json::to_value(&view).map_err(DbError::Serialize)?;
        let filters = serde_json::to_value(&view.filters).map_err(DbError::Serialize)?;
        with_audits(&self.pool, org, |tx| Box::pin(async move {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
                .bind(format!("employee_views|{org}|{actor}"))
                .execute(tx.as_mut()).await?;
            let existing: Option<(Uuid, Value)> = sqlx::query_as("SELECT user_id,jsonb_build_object('id',id,'name',name,'filters',filters) FROM employee_views WHERE org_id=$1 AND id=$2")
                .bind(org.as_uuid()).bind(view.id).fetch_optional(tx.as_mut()).await?;
            let owner = existing.as_ref().map_or(*actor.as_uuid(), |(owner, _)| *owner);
            require_owner(tx, org, actor, owner).await?;
            if let Some((_, stored)) = existing {
                if stored != request {
                    return Err(KernelError::conflict("view id was reused with different content").with_code("idempotency_key_reused").into());
                }
                return Ok((IdempotentCreate::Replay(stored), vec![]));
            }
            let now: time::OffsetDateTime = sqlx::query_scalar("SELECT now()").fetch_one(tx.as_mut()).await?;
            let key = SettingKey::DisplaySavedViewsMax;
            let settings = resolve_in_tx(tx.as_mut(), org, &[key], None, now).await?;
            let limit = match settings.get(&key).and_then(|value| value.as_ref().ok()).map(|value| value.value) {
                Some(SettingValue::Int(limit)) => limit,
                _ => return Err(KernelError::internal("saved-view limit did not resolve").into()),
            };
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM employee_views WHERE org_id=$1 AND user_id=$2")
                .bind(org.as_uuid()).bind(actor.as_uuid()).fetch_one(tx.as_mut()).await?;
            if count >= limit {
                return Err(KernelError::conflict("saved-view limit reached").with_code("employee_view_limit_reached").into());
            }
            let stored: Option<Value> = sqlx::query_scalar("INSERT INTO employee_views(org_id,user_id,id,name,filters) VALUES($1,$2,$3,$4,$5) ON CONFLICT (org_id,id) DO NOTHING RETURNING jsonb_build_object('id',id,'name',name,'filters',filters)")
                .bind(org.as_uuid()).bind(actor.as_uuid()).bind(view.id).bind(&view.name).bind(filters)
                .fetch_optional(tx.as_mut()).await.map_err(|error| match &error {
                    sqlx::Error::Database(db) if db.constraint() == Some("employee_views_owner_name") => PgOrgError::from(KernelError::conflict("a view with this name already exists").with_code("employee_view_name_taken")),
                    _ => error.into(),
                })?;
            let Some(stored) = stored else {
                let (owner, _): (Uuid, Value) = sqlx::query_as("SELECT user_id,jsonb_build_object('id',id,'name',name,'filters',filters) FROM employee_views WHERE org_id=$1 AND id=$2")
                    .bind(org.as_uuid()).bind(view.id).fetch_one(tx.as_mut()).await?;
                require_owner(tx, org, actor, owner).await?;
                return Err(KernelError::conflict("view was created concurrently").with_code("command_in_progress").into());
            };
            command_outcomes::set_result(tx, &stored).await?;
            let event = AuditEvent::new(Some(actor), AuditAction::new("employee_view.create")?, "employee_views", view.id.to_string(), TraceContext::generate(), now)
                .with_org(org).with_snapshots(None, Some(stored.clone()));
            Ok((IdempotentCreate::Created(stored), vec![event]))
        })).await
    }
}
