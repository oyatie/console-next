//! Undo of a bulk 법인 · 사업장 batch during SETUP (MR-29; onboarding-and-migration §5.4, C4).
//!
//! Never a blind revert: every record must still be at the version the batch
//! left it, and every 법인's 대표 / 본점 roles as the batch left them;
//! otherwise 409 `undo_conflict` and nothing is applied. A record the batch
//! created is voided by the setup void (people placed there refuse it:
//! `record_in_use`). A revised record gets a new revision that copies the
//! revision in force at the batch's date before it (the exact prior row, so a
//! migrated draft that today's rules would refuse comes back as it was), its
//! identifiers and `needs_confirmation`, and its SITE unit's name.

use console_entity_application::{Actor, EntitySetupBatchView};
use console_entity_domain::Refusal;
use console_kernel_core::{AuditEvent, WriteClass};
use console_platform_db::with_audits;
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::entity_batch_check::roles;
use crate::entity_batch_list::{uuid, view};
use crate::entity_batch_lookup::head;
use crate::legal_entity_tx::void_entity_in_tx;
use crate::org_units::OrgUnitSetupWritePort;
use crate::workplace_tx::void_workplace_in_tx;
use crate::{Admitted, PgEntityError, PgEntityStore, Tx, admit, audit, today_kst};

const REASON: &str = console_entity_domain::SystemReason::SetupUndo.as_str();

/// Copy revision `$1` as a new row (`$2` overrides id, version, command…).
const COPY_ENTITY: &str = "INSERT INTO legal_entity_revisions SELECT (jsonb_populate_record(NULL::legal_entity_revisions, \
     to_jsonb(r) || $2::jsonb || jsonb_build_object('created_at', now()))).* FROM legal_entity_revisions r WHERE r.id = $1";
const COPY_WORKPLACE: &str = "INSERT INTO workplace_revisions SELECT (jsonb_populate_record(NULL::workplace_revisions, \
     to_jsonb(r) || $2::jsonb || jsonb_build_object('created_at', now()))).* FROM workplace_revisions r WHERE r.id = $1";

impl PgEntityStore {
    /// Undo APPLY batch `batch` (SETUP only).
    ///
    /// # Errors
    /// `phase_not_setup`, `entity_setup_batch_not_found`, `batch_not_undoable`,
    /// `batch_already_undone`, `undo_conflict`, `record_in_use`, or database faults.
    pub async fn undo_entity_setup_batch(
        &self,
        actor: &Actor,
        batch: Uuid,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<EntitySetupBatchView, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                if let Some(done) = claim(tx, &actor, "entity_setup.undo", json!({ "batch": batch })).await? {
                    let id = done.target.ok_or_else(|| Refusal::not_found("entity_setup_batch_not_found"))?;
                    return Ok((view(tx, id).await?, vec![]));
                }
                let admitted = admit(tx, WriteClass::SetupVoid).await?;
                let row = sqlx::query("SELECT kind, undone_by, steps, roles FROM entity_setup_batches WHERE id = $1 FOR UPDATE")
                    .bind(batch)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| Refusal::not_found("entity_setup_batch_not_found"))?;
                if row.try_get::<String, _>("kind")? != "APPLY" {
                    return Err(Refusal::conflict("batch_not_undoable", "an undo cannot be undone").into());
                }
                if row.try_get::<Option<Uuid>, _>("undone_by")?.is_some() {
                    return Err(Refusal::conflict("batch_already_undone", "the batch was undone already").into());
                }
                let steps: Vec<Value> = serde_json::from_value(row.try_get("steps")?)?;
                let pins: Vec<Value> = serde_json::from_value(row.try_get("roles")?)?;
                let mut events = Vec::new();
                ensure_unchanged(tx, &steps, &pins).await?;
                for step in steps.iter().rev() {
                    let op_actor = Actor { command_id: Some(Uuid::new_v4()), ..actor.clone() };
                    events.push(revert(tx, &op_actor, admitted, step, port.as_ref()).await?);
                }
                restore_roles(tx, &pins).await?;
                let id: Uuid = sqlx::query_scalar(
                    "INSERT INTO entity_setup_batches (org_id, command_id, kind, undoes, change_mode, steps, actor_id) \
                     VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, 'UNDO', $2, $3, $4, $5) RETURNING id",
                )
                .bind(crate::command::command_id(&actor)?)
                .bind(batch)
                .bind(admitted.mode.as_str())
                .bind(Value::Array(steps.clone()))
                .bind(*actor.user.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
                sqlx::query("UPDATE entity_setup_batches SET undone_by = $2 WHERE id = $1")
                    .bind(batch)
                    .bind(id)
                    .execute(tx.as_mut())
                    .await?;
                events.push(audit(&actor, "entity_setup.undo", "entity_setup_batch", batch, admitted,
                    json!({ "undo_batch_id": id, "records": steps.len() }))?);
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(admitted.mode.as_str().into()), count: None }).await?;
                Ok((view(tx, id).await?, events))
            })
        })
        .await
    }
}

fn conflict(id: Option<Uuid>) -> PgEntityError {
    Refusal::conflict(
        "undo_conflict",
        format!(
            "record {} changed after the batch",
            id.map(|i| i.to_string()).unwrap_or_default()
        ),
    )
    .with_remedy("undo_later_batches_first")
    .into()
}

/// Every record still at the batch's after-version, every role as it left it.
async fn ensure_unchanged(
    tx: &mut Tx<'_>,
    steps: &[Value],
    pins: &[Value],
) -> Result<(), PgEntityError> {
    for step in steps {
        let (kind, id) = (
            step["target_type"].as_str().unwrap_or_default(),
            uuid(&step["target_id"]),
        );
        let id = id.ok_or_else(|| conflict(None))?;
        let (version, _) = head(tx, kind, id).await?;
        if i64::from(version) != step["after_version"].as_i64().unwrap_or(-1) {
            return Err(conflict(Some(id)));
        }
    }
    let entities: Vec<Uuid> = pins
        .iter()
        .filter_map(|p| uuid(&p["legal_entity_id"]))
        .collect();
    let now = roles(tx, &entities).await?;
    for pin in pins {
        if !now.iter().any(|r| r == &pin["after"]) {
            return Err(conflict(uuid(&pin["legal_entity_id"])));
        }
    }
    Ok(())
}

async fn restore_roles(tx: &mut Tx<'_>, pins: &[Value]) -> Result<(), PgEntityError> {
    for pin in pins {
        let b = &pin["before"];
        sqlx::query(
            "UPDATE legal_entities SET primary_workplace_id = $2, head_office_workplace_id = $3, \
               head_office_has_no_workplace = $4 WHERE id = $1 AND voided_at IS NULL",
        )
        .bind(uuid(&pin["legal_entity_id"]))
        .bind(uuid(&b["primary_workplace_id"]))
        .bind(uuid(&b["head_office_workplace_id"]))
        .bind(b["head_office_has_no_workplace"] == true)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

/// Revert one record: void it (created) or restore its prior revision.
async fn revert(
    tx: &mut Tx<'_>,
    actor: &Actor,
    admitted: Admitted,
    step: &Value,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<AuditEvent, PgEntityError> {
    let entity = step["target_type"] == "legal_entity";
    let id = uuid(&step["target_id"]).ok_or_else(|| conflict(None))?;
    if step["created"] == true {
        return if entity {
            void_entity_in_tx(tx, actor, admitted, id, REASON, port).await
        } else {
            void_workplace_in_tx(tx, actor, admitted, id, REASON, port).await
        };
    }
    let after = uuid(&step["after_revision_id"]).ok_or_else(|| conflict(Some(id)))?;
    let (table, key, copy) = if entity {
        ("legal_entity_revisions", "legal_entity_id", COPY_ENTITY)
    } else {
        ("workplace_revisions", "workplace_id", COPY_WORKPLACE)
    };
    // The row in force at the batch's date before it; else the earliest prior row.
    let prior: Uuid = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT p.id FROM {table} p, {table} a WHERE a.id = $1 AND p.{key} = a.{key} AND p.version < a.version \
         ORDER BY (p.effective_from <= a.effective_from) DESC, \
                  CASE WHEN p.effective_from <= a.effective_from THEN p.effective_from END DESC NULLS LAST, \
                  p.effective_from, p.version DESC LIMIT 1"
    )))
    .bind(after)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| conflict(Some(id)))?;
    let (version, _) = head(tx, if entity { "legal_entity" } else { "workplace" }, id).await?;
    let effective: time::Date = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT effective_from FROM {table} WHERE id = $1"
    )))
    .bind(after)
    .fetch_one(tx.as_mut())
    .await?;
    let new_id = Uuid::new_v4();
    let overrides = json!({
        "id": new_id, "version": version + 1, "command_id": crate::command::command_id(actor)?,
        "effective_from": effective.to_string(), "change_mode": admitted.mode.as_str(), "reason_code": REASON,
        "actor_id": actor.user.as_uuid(), "settings_snapshot": admitted.snapshot(),
    });
    sqlx::query(copy)
        .bind(prior)
        .bind(overrides)
        .execute(tx.as_mut())
        .await?;
    let confirm = step["before_needs_confirmation"] == true;
    if entity {
        for sql in [
            "INSERT INTO legal_entity_representatives (org_id, revision_id, seq, name) \
             SELECT org_id, $2, seq, name FROM legal_entity_representatives WHERE revision_id = $1",
            "INSERT INTO legal_entity_directors (org_id, revision_id, seq, role, name, appointed_on) \
             SELECT org_id, $2, seq, role, name, appointed_on FROM legal_entity_directors WHERE revision_id = $1",
        ] {
            sqlx::query(sql)
                .bind(prior)
                .bind(new_id)
                .execute(tx.as_mut())
                .await?;
        }
        sqlx::query("UPDATE legal_entities SET biz_kind = $2, crn = $3, needs_confirmation = $4 WHERE id = $1")
            .bind(id)
            .bind(step["before_biz_kind"].as_str())
            .bind(step["before_crn"].as_str())
            .bind(confirm)
            .execute(tx.as_mut())
            .await?;
        // The restored 법인명 reaches the registrations' N-1 `trade_name` too.
        let name: String =
            sqlx::query_scalar("SELECT name FROM legal_entity_revisions WHERE id = $1")
                .bind(new_id)
                .fetch_one(tx.as_mut())
                .await?;
        let at = crate::revision_copy::RevisionAt {
            admitted,
            actor: actor.user,
            command: crate::command::command_id(actor)?,
        };
        crate::revision_copy::append_renamed_registrations(tx, id, &name, effective, at).await?;
    } else {
        sqlx::query("UPDATE workplaces SET needs_confirmation = $2 WHERE id = $1")
            .bind(id)
            .bind(confirm)
            .execute(tx.as_mut())
            .await?;
        let today = today_kst(tx).await?;
        if effective <= today {
            let name: String =
                sqlx::query_scalar("SELECT name FROM workplace_revisions WHERE id = $1")
                    .bind(new_id)
                    .fetch_one(tx.as_mut())
                    .await?;
            crate::site_unit::rename_site(tx, actor, id, &name, today, port).await?;
        }
    }
    let target = if entity { "legal_entity" } else { "workplace" };
    audit(
        actor,
        &format!("{target}.setup_undo"),
        target,
        id,
        admitted,
        json!({ "version": version + 1, "restored_from": prior }),
    )
}
