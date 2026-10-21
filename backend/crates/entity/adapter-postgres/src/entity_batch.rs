//! Bulk 법인 · 사업장 create and update from a sheet (MR-29, decisions #21).
//!
//! One batch = one transaction (onboarding-and-migration C12). The dry run
//! runs the real writers and rolls back (`with_org_rollback`), so its verdict
//! is the apply's: each op under a savepoint, every row's refusal listed at
//! once, a field diff per revised record and a digest over the request, the
//! targets' versions, today and the tenant phase. The apply must carry that
//! digest (a change since → 409 `rows_changed_since_preview`), refuses on the
//! first failing op (nothing applied) and leaves a receipt that SETUP can undo
//! (`entity_batch_undo`). After 운영 시작 the same writers run governed, as
//! the one-by-one routes do; only the undo is SETUP-only.
//!
//! 법인 and 사업장 only (a 사업장 row takes an existing
//! `registration_id`); 사업자등록 ops, and running inside the people import
//! run's transaction (onboarding-and-migration §3.4), are followups #31-#32.

use std::collections::HashMap;

use console_entity_application::{
    Actor, EntitySetupBatch, EntitySetupItem, EntitySetupResult, OpError,
};
use console_entity_domain::Refusal;
use console_kernel_core::{AuditEvent, WriteClass};
use console_platform_db::{with_audits, with_org_rollback};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::entity_batch_check::{
    at_op, check_shape, digest, roles, savepoint_end, touched_entities,
};
use crate::entity_batch_ops::{OpCtx, OpErr, exec};
use crate::org_units::OrgUnitSetupWritePort;
use crate::{PgEntityError, PgEntityStore, Tx, admit, audit, today_kst};

struct Run {
    admitted: crate::Admitted,
    result: EntitySetupResult,
    steps: Vec<Value>,
    roles: Vec<Value>,
    events: Vec<AuditEvent>,
}

impl PgEntityStore {
    /// Dry-run or apply a bulk 법인 · 사업장 batch.
    ///
    /// # Errors
    /// Shape issues (`ops[i].*`), `rows_changed_since_preview`, the first
    /// op's refusal on an apply (fields prefixed `ops[i].`), or database faults.
    pub async fn entity_setup_batch(
        &self,
        actor: &Actor,
        batch: EntitySetupBatch,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<EntitySetupResult, PgEntityError> {
        let actor = actor.clone();
        if batch.dry_run {
            return with_org_rollback(&self.pool, actor.org, move |tx| {
                Box::pin(async move { Ok(run(tx, &actor, &batch, port.as_ref()).await?.result) })
            })
            .await;
        }
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let request = json!({ "batch": batch.digest_body(), "preview_digest": batch.preview_digest });
                if let Some(done) = claim(tx, &actor, "entity_setup.apply", request).await? {
                    return Ok((replay(tx, done, &batch).await?, vec![]));
                }
                let mut run = run(tx, &actor, &batch, port.as_ref()).await?;
                let id: Uuid = sqlx::query_scalar(
                    "INSERT INTO entity_setup_batches (org_id, command_id, kind, change_mode, steps, roles, actor_id) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, 'APPLY', $2, $3, $4, $5) \
                     RETURNING id",
                )
                .bind(crate::command::command_id(&actor)?)
                .bind(&run.result.change_mode)
                .bind(Value::Array(run.steps.clone()))
                .bind(Value::Array(run.roles.clone()))
                .bind(*actor.user.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
                run.events.push(audit(&actor, "entity_setup.apply", "entity_setup_batch", id, run.admitted,
                    json!({ "records": run.steps.len() }))?);
                let mode = Some(run.result.change_mode.clone());
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: mode, count: None }).await?;
                run.result.batch_id = Some(id);
                Ok((run.result, run.events))
            })
        })
        .await
    }
}

async fn run(
    tx: &mut Tx<'_>,
    actor: &Actor,
    batch: &EntitySetupBatch,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<Run, PgEntityError> {
    let admitted = admit(tx, WriteClass::EntityStructure).await?;
    let today = today_kst(tx).await?;
    check_shape(batch)?;
    let digest = digest(tx, batch, admitted.phase.as_str(), today).await?;
    if !batch.dry_run {
        match batch.preview_digest.as_deref() {
            None => return Err(Refusal::field("preview_digest", "required").into()),
            Some(d) if d != digest => {
                return Err(Refusal::conflict(
                    "rows_changed_since_preview",
                    "the records changed since the preview",
                )
                .with_remedy("preview_again")
                .into());
            }
            Some(_) => {}
        }
    }
    let touched = touched_entities(tx, batch).await?;
    let before_roles = roles(tx, &touched).await?;
    let mut refs: HashMap<String, Uuid> = HashMap::new();
    let (mut items, mut steps, mut events) = (Vec::new(), Vec::new(), Vec::new());
    for (index, op) in batch.ops.iter().enumerate() {
        let op_actor = Actor {
            command_id: Some(Uuid::new_v4()),
            ..actor.clone()
        };
        let ctx = OpCtx {
            actor: &op_actor,
            admitted,
            today,
            effective_from: batch.effective_from.as_deref(),
            reason_code: batch.reason_code.as_deref(),
            refs: &refs,
            port,
        };
        sqlx::query("SAVEPOINT entity_setup_op")
            .execute(tx.as_mut())
            .await?;
        let kind = op.op.clone().unwrap_or_default();
        let mut item = EntitySetupItem {
            index,
            reference: op.reference.clone(),
            op: kind,
            outcome: "ERROR",
            target_id: None,
            version: None,
            changes: Vec::new(),
            warnings: Vec::new(),
            error: None,
        };
        match exec(tx, &ctx, op).await {
            Ok(done) => {
                let unchanged = done.unchanged();
                savepoint_end(tx, unchanged).await?;
                if let Some(r) = &op.reference {
                    refs.insert(r.clone(), done.target);
                }
                item.outcome = if done.created {
                    "CREATED"
                } else if unchanged {
                    "UNCHANGED"
                } else {
                    "CHANGED"
                };
                item.target_id = Some(done.target);
                item.version = Some(if unchanged {
                    done.version - 1
                } else {
                    done.version
                });
                (item.changes, item.warnings) = (done.changes, done.warnings);
                if !unchanged {
                    let mut step = done.step;
                    step["op"] = json!(item.op);
                    step["legal_entity_id"] = json!(done.entity);
                    steps.push(step);
                    events.extend(done.events);
                }
            }
            Err(OpErr::Fatal(err)) => return Err(err),
            Err(OpErr::Refused(refusal, existing)) => {
                if !batch.dry_run {
                    return Err(at_op(index, refusal).into());
                }
                savepoint_end(tx, true).await?;
                item.error = Some(OpError {
                    code: refusal.code,
                    message: refusal.message,
                    fields: refusal.fields,
                    remedy: refusal.remedy,
                    current_version: refusal.current_version,
                    existing_id: existing,
                });
            }
        }
        items.push(item);
    }
    let after_roles = roles(tx, &touched).await?;
    let roles = before_roles
        .into_iter()
        .zip(after_roles)
        .filter(|(b, a)| b != a)
        .map(|(b, a)| json!({ "legal_entity_id": b["id"], "before": b, "after": a }))
        .collect();
    let result = EntitySetupResult {
        dry_run: batch.dry_run,
        preview_digest: digest,
        batch_id: None,
        change_mode: admitted.mode.as_str().to_owned(),
        items,
    };
    Ok(Run {
        admitted,
        result,
        steps,
        roles,
        events,
    })
}

/// A replayed apply: the receipt as it was written (no diffs; ids and versions).
async fn replay(
    tx: &mut Tx<'_>,
    done: Outcome,
    batch: &EntitySetupBatch,
) -> Result<EntitySetupResult, PgEntityError> {
    let id = done
        .target
        .ok_or_else(|| Refusal::not_found("entity_setup_batch_not_found"))?;
    let steps: Value = sqlx::query_scalar("SELECT steps FROM entity_setup_batches WHERE id = $1")
        .bind(id)
        .fetch_one(tx.as_mut())
        .await?;
    let items = steps
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, s)| EntitySetupItem {
            index,
            reference: None,
            op: s["op"].as_str().unwrap_or_default().to_owned(),
            outcome: if s["created"] == true {
                "CREATED"
            } else {
                "CHANGED"
            },
            target_id: s["target_id"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok()),
            version: s["after_version"]
                .as_i64()
                .and_then(|v| i32::try_from(v).ok()),
            changes: Vec::new(),
            warnings: Vec::new(),
            error: None,
        })
        .collect();
    Ok(EntitySetupResult {
        dry_run: false,
        preview_digest: batch.preview_digest.clone().unwrap_or_default(),
        batch_id: Some(id),
        change_mode: done.change_mode.unwrap_or_default(),
        items,
    })
}
