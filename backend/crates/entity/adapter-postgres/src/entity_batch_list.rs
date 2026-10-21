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
                let ids: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM entity_setup_batches ORDER BY created_at DESC LIMIT 200",
                )
                .fetch_all(tx.as_mut())
                .await?;
                let mut out = Vec::with_capacity(ids.len());
                for id in ids {
                    out.push(view(tx, id).await?);
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
        "SELECT kind, undoes, undone_by, change_mode, jsonb_array_length(steps)::int8 AS n, \
                to_json(created_at) #>> '{}' AS created_at FROM entity_setup_batches WHERE id = $1",
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
    })
}
