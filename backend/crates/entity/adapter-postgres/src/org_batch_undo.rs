//! 「되돌리기」 of a setup 부서 batch (design OM §3.5, §5.4), the replay of
//! a batch command, and the batch list behind 「설정 단계 기록」.
//!
//! An undo puts every unit the batch touched back to its before-image (a
//! unit the batch created is dissolved), through the same writer, so a 부서
//! moved back to its old 사업장 takes its people's placement back too. It is
//! never blind: a unit that no longer holds what the batch left refuses the
//! whole undo (later batches first, LIFO), and a created unit that has people or
//! 부서 of its own by now stays. Setup only; the receipt's 되돌리기 ends at
//! 운영 시작.

use std::collections::HashMap;
use std::sync::Arc;

use console_entity_application::{Actor, OrgSetupBatchView, OrgSetupReceipt};
use console_entity_domain::{FieldIssue, Refusal};
use console_kernel_core::{TenantPhase, WriteClass};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::command::Outcome;
use crate::command::claim;
use crate::org_batch::{Run, Step};
use crate::org_tree;
use crate::org_units::OrgUnitSetupWritePort;
use crate::{PgEntityError, PgEntityStore, Tx, admit, read_phase, today_kst};

/// A replayed command's receipt, re-read from its batch row.
pub(crate) async fn replay(
    tx: &mut Tx<'_>,
    done: Outcome,
) -> Result<OrgSetupReceipt, PgEntityError> {
    let batch = done
        .target
        .ok_or_else(|| Refusal::not_found("org_setup_batch_not_found"))?;
    let steps: serde_json::Value =
        sqlx::query_scalar("SELECT steps FROM org_setup_batches WHERE id = $1")
            .bind(batch)
            .fetch_one(tx.as_mut())
            .await?;
    let steps: Vec<Step> = serde_json::from_value(steps)?;
    Ok(OrgSetupReceipt {
        batch_id: batch,
        change_mode: done.change_mode.unwrap_or_default(),
        units: steps.iter().map(Step::unit).collect(),
    })
}

/// Per unit, in the order the batch first touched it: the first step's
/// before-image and the last step's version.
fn per_unit(steps: &[Step]) -> Vec<(Uuid, Option<crate::org_batch::Before>, i64)> {
    let mut order: Vec<Uuid> = Vec::new();
    let mut units: HashMap<Uuid, (Option<crate::org_batch::Before>, i64)> = HashMap::new();
    for step in steps {
        units
            .entry(step.org_unit_id)
            .and_modify(|u| u.1 = step.after_version)
            .or_insert_with(|| {
                order.push(step.org_unit_id);
                (step.before.clone(), step.after_version)
            });
    }
    order
        .into_iter()
        .filter_map(|id| units.remove(&id).map(|(before, after)| (id, before, after)))
        .collect()
}

/// Whether the unit still holds what the batch left (name, kind, parent,
/// status; the effective date aside). A later batch that was itself undone
/// leaves it so again, which is what lets undo go last-in, first-out.
async fn as_batch_left_it(
    tx: &mut crate::Tx<'_>,
    id: Uuid,
    after: i64,
) -> Result<bool, PgEntityError> {
    let Some(now) = org_tree::head(tx, id).await? else {
        return Ok(false);
    };
    if now.version == after {
        return Ok(true);
    }
    let then: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT attributes FROM org_unit_revisions WHERE org_unit_id = $1 AND version = $2",
    )
    .bind(id)
    .bind(after)
    .fetch_optional(tx.as_mut())
    .await?;
    let strip = |mut v: serde_json::Value| {
        if let Some(map) = v.as_object_mut() {
            map.remove("effective_from");
        }
        v
    };
    Ok(then.is_some_and(|then| strip(then) == strip(now.attributes)))
}

impl PgEntityStore {
    /// Undo the setup batch `batch`.
    ///
    /// # Errors
    /// `phase_not_setup`, `org_setup_batch_not_found`, `batch_not_undoable`
    /// (an undo), `batch_already_undone`, `undo_conflict` (a unit changed
    /// since; remedy `undo_later_batches_first`), `undo_unit_in_use`.
    pub async fn undo_org_setup_batch(
        &self,
        actor: &Actor,
        batch: Uuid,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<OrgSetupReceipt, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "org_unit.setup_undo", json!({ "batch_id": batch })).await? {
                    return Ok((replay(tx, done).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::OrgStructure).await?;
                let row = sqlx::query("SELECT kind, steps, undone_by FROM org_setup_batches WHERE id = $1 FOR UPDATE")
                    .bind(batch)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| Refusal::not_found("org_setup_batch_not_found"))?;
                if row.try_get::<String, _>("kind")? != "APPLY" {
                    return Err(Refusal::conflict("batch_not_undoable", "an undo is not undone").into());
                }
                if row.try_get::<Option<Uuid>, _>("undone_by")?.is_some() {
                    return Err(Refusal::conflict("batch_already_undone", "this batch was already undone").into());
                }
                let steps: Vec<Step> = serde_json::from_value(row.try_get("steps")?)?;
                let units = per_unit(&steps);
                let ids: Vec<Uuid> = units.iter().map(|u| u.0).collect();
                org_tree::lock_units(tx, &ids).await?;
                let mut changed = Vec::new();
                for (id, _, after) in &units {
                    if !as_batch_left_it(tx, *id, *after).await? {
                        changed.push(FieldIssue { field: id.to_string(), code: "changed_since_batch" });
                    }
                }
                if !changed.is_empty() {
                    let mut refusal = Refusal::conflict(
                        "undo_conflict",
                        format!("{} org units changed after this batch; undo the later changes first", changed.len()),
                    )
                    .with_remedy("undo_later_batches_first");
                    refusal.fields = changed;
                    return Err(refusal.into());
                }
                let mut run = Run {
                    actor: &actor,
                    port: port.as_ref(),
                    admitted,
                    today: today_kst(tx).await?,
                    batch: Uuid::new_v4(),
                    legacy: false,
                    refs: HashMap::new(),
                    steps: Vec::new(),
                    events: Vec::new(),
                };
                // Reverse order: children the batch created go before their
                // parents; parents it dissolved come back before children.
                for (i, (id, before, _)) in units.into_iter().rev().enumerate() {
                    let head = org_tree::head(tx, id).await?.ok_or_else(|| Refusal::not_found("org_unit_not_found"))?;
                    let attributes = match before {
                        Some(before) => before.attributes,
                        None => {
                            let people = org_tree::members(tx, &[id]).await?;
                            let units_under = org_tree::subtree(tx, &[id]).await?.len().saturating_sub(1);
                            if people > 0 || units_under > 0 {
                                return Err(Refusal::conflict(
                                    "undo_unit_in_use",
                                    format!("org unit {id} has {people} people and {units_under} units of its own now"),
                                )
                                .with_remedy(if people > 0 { "move_people_first" } else { "move_or_dissolve_units_first" })
                                .into());
                            }
                            let mut attributes = head.attributes.clone();
                            attributes["status"] = json!("dissolved");
                            attributes
                        }
                    };
                    run.write(tx, i, None, Some((id, head)), attributes, "org_unit.setup_revert").await?;
                }
                let undo = run.batch;
                let out = run.record(tx, "UNDO", Some(batch)).await?;
                sqlx::query("UPDATE org_setup_batches SET undone_by = $2 WHERE id = $1")
                    .bind(batch)
                    .bind(undo)
                    .execute(tx.as_mut())
                    .await?;
                Ok(out)
            })
        })
        .await
    }

    /// The tenant's recent setup 부서 batches, newest first.
    ///
    /// the latest 200; page by `created_at` if a setup ever runs
    /// more batches than a screen can list.
    ///
    /// # Errors
    /// Database faults.
    pub async fn list_org_setup_batches(
        &self,
        actor: &Actor,
    ) -> Result<Vec<OrgSetupBatchView>, PgEntityError> {
        with_org_conn(&self.pool, actor.org, |tx| {
            Box::pin(async move {
                let setup = read_phase(tx, false).await? == TenantPhase::Setup;
                let rows = sqlx::query(
                    "SELECT id, kind, undoes, undone_by, steps, actor_id, created_at FROM org_setup_batches \
                     ORDER BY created_at DESC, id LIMIT 200",
                )
                .fetch_all(tx.as_mut())
                .await?;
                let mut out = Vec::with_capacity(rows.len());
                for r in rows {
                    let kind: String = r.try_get("kind")?;
                    let undone_by: Option<Uuid> = r.try_get("undone_by")?;
                    let steps: Vec<Step> = serde_json::from_value(r.try_get("steps")?)?;
                    out.push(OrgSetupBatchView {
                        id: r.try_get("id")?,
                        undoable: setup && kind == "APPLY" && undone_by.is_none(),
                        kind,
                        undoes: r.try_get("undoes")?,
                        undone_by,
                        units: steps.iter().map(Step::unit).collect(),
                        actor_id: r.try_get("actor_id")?,
                        created_at: r.try_get("created_at")?,
                    });
                }
                Ok(out)
            })
        })
        .await
    }
}
