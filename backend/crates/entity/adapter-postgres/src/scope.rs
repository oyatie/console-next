//! Scope-grant facts (decisions #15): the resource ids a write touches (a
//! record's own 법인 id and, for a 사업장, its id too), and the facts a
//! grant's 업무위탁 basis is checked against.

use console_entity_application::{Actor, GrantBasisFacts, Target};
use console_entity_domain::Refusal;
use console_kernel_core::{ErrorKind, Timestamp, UserId};
use console_platform_db::with_org_conn;
use console_settings_domain::{OverrideRow, SettingKey, SettingValue, resolve};
use sqlx::Row;
use uuid::Uuid;

use crate::{PgEntityError, PgEntityStore};

impl PgEntityStore {
    /// `[법인]`, `[법인, 사업장]`, or nothing for a tenant-level act or an
    /// unknown record (which then only a tenant-wide scope reaches, and the
    /// write itself answers not-found).
    ///
    /// # Errors
    /// Database faults.
    pub async fn target_ids(
        &self,
        actor: &Actor,
        target: Target,
    ) -> Result<Vec<Uuid>, PgEntityError> {
        let (sql, id): (&'static str, Uuid) = match target {
            Target::Tenant => return Ok(Vec::new()),
            Target::Entity(id) => return Ok(vec![id]),
            Target::Registration(id) => (
                "SELECT ARRAY[legal_entity_id] FROM business_registrations WHERE id = $1",
                id,
            ),
            Target::Workplace(id) => (
                "SELECT ARRAY[legal_entity_id, id] FROM workplaces WHERE id = $1",
                id,
            ),
        };
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let ids: Option<Vec<Uuid>> = sqlx::query_scalar(sql)
                    .bind(id)
                    .fetch_optional(tx.as_mut())
                    .await?;
                Ok(ids.unwrap_or_default())
            })
        })
        .await
    }
}

impl PgEntityStore {
    /// The basis facts for a grant to `holder` on `target` (decisions #15.2),
    /// for the scope-grant use case (E-S5) to pass to `check_grant_basis`.
    /// The setting fails closed: a stored value that no longer parses is an
    /// error, never the default.
    ///
    /// the tenant-row SELECT mirrors settings-adapter-postgres
    /// `load_rows_in_tx` (entity-adapter → settings-adapter is an illegal
    /// edge, the G18 precedent); ADR-006 moves that read to platform-db.
    ///
    /// # Errors
    /// Database faults or an unreadable stored setting.
    pub async fn grant_basis_facts(
        &self,
        actor: &Actor,
        holder: UserId,
        target: Target,
    ) -> Result<GrantBasisFacts, PgEntityError> {
        let key = SettingKey::AuthzCrossEntityGrantBasisRequired;
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    "SELECT id, value, effective_from FROM tenant_setting_overrides \
                     WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::uuid \
                       AND key = $1 AND scope_entity_id IS NULL",
                )
                .bind(key.as_str())
                .fetch_all(tx.as_mut())
                .await?;
                let mut own = Vec::new();
                for row in &rows {
                    let raw: serde_json::Value = row.try_get("value")?;
                    let value = key.def().parse(&raw).ok_or_else(|| unreadable(key))?;
                    own.push(OverrideRow {
                        id: row.try_get("id")?,
                        scope_entity_id: None,
                        value,
                        effective_from: row.try_get("effective_from")?,
                    });
                }
                let now: Timestamp = sqlx::query_scalar("SELECT now()").fetch_one(tx.as_mut()).await?;
                let required = match resolve(key, &own, None, now).map_err(|_| unreadable(key))?.value {
                    SettingValue::Bool(on) => on,
                    _ => return Err(unreadable(key)),
                };
                // The target 법인: the record's own, or a 사업장's 법인.
                let entity: Option<Uuid> = match target {
                    Target::Tenant => None,
                    Target::Entity(id) => Some(id),
                    Target::Registration(id) => {
                        sqlx::query_scalar("SELECT legal_entity_id FROM business_registrations WHERE id = $1")
                            .bind(id)
                            .fetch_optional(tx.as_mut())
                            .await?
                    }
                    Target::Workplace(id) => {
                        sqlx::query_scalar("SELECT legal_entity_id FROM workplaces WHERE id = $1")
                            .bind(id)
                            .fetch_optional(tx.as_mut())
                            .await?
                    }
                };
                let employed = match entity {
                    None => true,
                    Some(entity) => sqlx::query_scalar(
                        "SELECT EXISTS (SELECT 1 FROM users u JOIN employment_assignments a ON a.employee_id = u.employee_id \
                           WHERE u.id = $1 AND a.legal_entity_id = $2 AND a.superseded_at IS NULL \
                             AND a.valid_from <= (now() AT TIME ZONE 'Asia/Seoul')::date \
                             AND (a.valid_to IS NULL OR a.valid_to > (now() AT TIME ZONE 'Asia/Seoul')::date))",
                    )
                    .bind(*holder.as_uuid())
                    .bind(entity)
                    .fetch_one(tx.as_mut())
                    .await?,
                };
                Ok(GrantBasisFacts {
                    required,
                    holder_employed_by_target: employed,
                })
            })
        })
        .await
    }
}

fn unreadable(key: SettingKey) -> PgEntityError {
    Refusal::new(
        ErrorKind::Internal,
        "setting_unreadable",
        format!("stored {} does not parse", key.as_str()),
    )
    .into()
}

impl PgEntityStore {
    /// The open 사업장 backed by `branches` (a caller's legacy branch reach,
    /// worst-case-08): their ids, for the caller's entity scope.
    ///
    /// # Errors
    /// Database faults.
    pub async fn workplaces_on_branches(
        &self,
        org: console_kernel_core::OrgId,
        branches: &[Uuid],
    ) -> Result<Vec<Uuid>, PgEntityError> {
        if branches.is_empty() {
            return Ok(Vec::new());
        }
        let branches = branches.to_vec();
        with_org_conn(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_scalar(
                    "SELECT id FROM workplaces WHERE default_branch_id = ANY($1) AND voided_at IS NULL",
                )
                .bind(&branches)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await
    }
}
