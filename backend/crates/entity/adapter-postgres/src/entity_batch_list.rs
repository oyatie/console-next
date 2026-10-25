//! Bulk 법인 · 사업장 batch receipts (MR-29): the list, one receipt, and the
//! records a batch touched (for the per-subject check of its undo).

use console_entity_application::{Actor, EntitySetupBatchView};
use console_entity_domain::Refusal;
use console_kernel_core::TenantPhase;
use console_platform_db::with_org_conn;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::{PgEntityError, PgEntityStore, Tx, read_phase};

impl PgEntityStore {
    /// The latest 200 receipts, newest first.
    ///
    /// # Errors
    /// Database faults.
    pub async fn list_entity_setup_batches(
        &self,
        actor: &Actor,
    ) -> Result<Vec<EntitySetupBatchView>, PgEntityError> {
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    "SELECT id, false AS registration, created_at FROM entity_setup_batches \
                     UNION ALL SELECT command_id, true, created_at FROM entity_commands \
                       WHERE action IN ('legal_entity.create', 'workplace.create') AND outcome->>'target' IS NOT NULL \
                     ORDER BY created_at DESC, id LIMIT 200",
                )
                .fetch_all(tx.as_mut())
                .await?;
                let mut out = Vec::with_capacity(rows.len());
                for row in rows {
                    let id = row.try_get("id")?;
                    out.push(if row.try_get("registration")? {
                        registration_view(tx, id).await?
                    } else {
                        view(tx, id).await?
                    });
                }
                Ok(out)
            })
        })
        .await
    }

    /// The 법인 · 사업장 a batch touched, for the per-subject authorization of its undo.
    ///
    /// # Errors
    /// `entity_setup_batch_not_found`, or database faults.
    pub async fn entity_setup_batch_targets(
        &self,
        actor: &Actor,
        batch: Uuid,
    ) -> Result<Vec<(String, Uuid)>, PgEntityError> {
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let steps: Value =
                    sqlx::query_scalar("SELECT steps FROM entity_setup_batches WHERE id = $1")
                        .bind(batch)
                        .fetch_optional(tx.as_mut())
                        .await?
                        .ok_or_else(|| Refusal::not_found("entity_setup_batch_not_found"))?;
                let steps: Vec<Value> = serde_json::from_value(steps)?;
                Ok(steps
                    .iter()
                    .filter_map(|s| {
                        Some((
                            s["target_type"].as_str()?.to_owned(),
                            uuid(&s["target_id"])?,
                        ))
                    })
                    .collect())
            })
        })
        .await
    }
}

pub(crate) fn uuid(v: &Value) -> Option<Uuid> {
    v.as_str().and_then(|s| Uuid::parse_str(s).ok())
}

pub(crate) async fn view(tx: &mut Tx<'_>, id: Uuid) -> Result<EntitySetupBatchView, PgEntityError> {
    let r = sqlx::query(
        "SELECT b.kind, b.undoes, b.undone_by, b.change_mode, jsonb_array_length(b.steps)::int8 AS n, \
                to_json(b.created_at) #>> '{}' AS created_at, b.actor_id, u.display_name AS actor_name, \
                ARRAY(SELECT DISTINCT s->>'op' FROM jsonb_array_elements(b.steps) s WHERE s->>'op' IS NOT NULL ORDER BY 1) AS actions, \
                ARRAY(SELECT DISTINCT COALESCE(e.name, w.name) FROM jsonb_array_elements(b.steps) s \
                  LEFT JOIN legal_entity_revisions e ON s->>'target_type' = 'legal_entity' \
                    AND e.legal_entity_id = (s->>'target_id')::uuid AND e.version = (s->>'after_version')::int \
                  LEFT JOIN workplace_revisions w ON s->>'target_type' = 'workplace' \
                    AND w.workplace_id = (s->>'target_id')::uuid AND w.version = (s->>'after_version')::int \
                  WHERE COALESCE(e.name, w.name) IS NOT NULL ORDER BY 1) AS target_names \
         FROM entity_setup_batches b LEFT JOIN person_accounts_current u ON u.id = b.actor_id WHERE b.id = $1",
    )
    .bind(id)
    .fetch_one(tx.as_mut())
    .await?;
    let (kind, undone_by, mode): (String, Option<Uuid>, String) = (
        r.try_get("kind")?,
        r.try_get("undone_by")?,
        r.try_get("change_mode")?,
    );
    let setup = read_phase(tx, false).await? == TenantPhase::Setup;
    Ok(EntitySetupBatchView {
        id,
        undoable: setup && kind == "APPLY" && undone_by.is_none() && mode == "SETUP",
        kind,
        undoes: r.try_get("undoes")?,
        undone_by,
        change_mode: mode,
        records: usize::try_from(r.try_get::<i64, _>("n")?).unwrap_or(0),
        created_at: r.try_get("created_at")?,
        actor_id: r.try_get("actor_id")?,
        actor_name: r.try_get("actor_name")?,
        actions: Some(r.try_get("actions")?),
        target_names: Some(r.try_get("target_names")?),
        registration_action: None,
    })
}

async fn registration_view(
    tx: &mut Tx<'_>,
    id: Uuid,
) -> Result<EntitySetupBatchView, PgEntityError> {
    let r = sqlx::query(
        "SELECT c.action, c.actor_id, u.display_name AS actor_name, c.outcome->>'change_mode' AS change_mode, \
           to_json(c.created_at) #>> '{}' AS created_at, COALESCE(e.name, w.name) AS name \
         FROM entity_commands c LEFT JOIN person_accounts_current u ON u.id = c.actor_id \
         LEFT JOIN legal_entity_revisions e ON c.action = 'legal_entity.create' \
           AND e.legal_entity_id = (c.outcome->>'target')::uuid AND e.version = 1 \
         LEFT JOIN workplace_revisions w ON c.action = 'workplace.create' \
           AND w.workplace_id = (c.outcome->>'target')::uuid AND w.version = 1 \
         WHERE c.command_id = $1",
    )
    .bind(id)
    .fetch_one(tx.as_mut())
    .await?;
    let action: String = r.try_get("action")?;
    let op = if action == "legal_entity.create" {
        "CREATE_ENTITY"
    } else {
        "CREATE_WORKPLACE"
    };
    Ok(EntitySetupBatchView {
        id,
        kind: "APPLY".into(),
        undoes: None,
        undone_by: None,
        change_mode: r.try_get("change_mode")?,
        records: 1,
        created_at: r.try_get("created_at")?,
        undoable: false,
        actor_id: r.try_get("actor_id")?,
        actor_name: r.try_get("actor_name")?,
        actions: Some(vec![op.into()]),
        target_names: Some(
            r.try_get::<Option<String>, _>("name")?
                .into_iter()
                .collect(),
        ),
        registration_action: Some(action),
    })
}
