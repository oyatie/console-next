//! One op of a bulk 법인 · 사업장 batch (MR-29): the one-by-one writers, run
//! inside the batch transaction, plus what the receipt and the preview need
//! (the record's state before and after, as history's field diff).

use std::collections::HashMap;

use console_entity_application::{
    Actor, CreateWorkplace, EntitySetupOp, FieldChange, LegalEntityRevision, Revision,
    WorkplaceRevision,
};
use console_entity_domain::{Refusal, Warning};
use console_kernel_core::AuditEvent;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::entity_batch_lookup::{
    existing_entity, existing_workplace, head, state, workplace_state,
};
use crate::legal_entity_tx::{create_entity_in_tx, revise_entity_in_tx};
use crate::org_units::OrgUnitSetupWritePort;
use crate::workplace::set_roles_on_create;
use crate::workplace_tx::{create_workplace_in_tx, revise_workplace_in_tx};
use crate::{Admitted, PgEntityError, Tx};

pub(crate) const CREATE_ENTITY: &str = "CREATE_ENTITY";
pub(crate) const REVISE_ENTITY: &str = "REVISE_ENTITY";
pub(crate) const CREATE_WORKPLACE: &str = "CREATE_WORKPLACE";
pub(crate) const REVISE_WORKPLACE: &str = "REVISE_WORKPLACE";

/// Why an op did not apply: a refusal shown on its row (with the record it
/// matched, for `already_exists`), or a fault that aborts the batch.
pub(crate) enum OpErr {
    Refused(Refusal, Option<Uuid>),
    Fatal(PgEntityError),
}

impl From<PgEntityError> for OpErr {
    fn from(err: PgEntityError) -> Self {
        match err {
            PgEntityError::Refused(r) => Self::Refused(r, None),
            other => Self::Fatal(other),
        }
    }
}

impl From<Refusal> for OpErr {
    fn from(r: Refusal) -> Self {
        Self::Refused(r, None)
    }
}

impl From<sqlx::Error> for OpErr {
    fn from(err: sqlx::Error) -> Self {
        PgEntityError::from(err).into()
    }
}

pub(crate) struct OpDone {
    pub target: Uuid,
    pub entity: Uuid,
    pub created: bool,
    pub version: i32,
    pub changes: Vec<FieldChange>,
    pub warnings: Vec<Warning>,
    /// The receipt step (ids, versions, flags; no values).
    pub step: Value,
    pub events: Vec<AuditEvent>,
}

impl OpDone {
    /// A revise that changes nothing (and confirms no draft) is not written.
    pub fn unchanged(&self) -> bool {
        !self.created && self.changes.is_empty() && self.step["before_needs_confirmation"] != true
    }
}

/// The batch-wide parts every op shares.
pub(crate) struct OpCtx<'a> {
    pub actor: &'a Actor,
    pub admitted: Admitted,
    pub today: time::Date,
    pub effective_from: Option<&'a str>,
    pub reason_code: Option<&'a str>,
    pub refs: &'a HashMap<String, Uuid>,
    pub port: &'a dyn OrgUnitSetupWritePort,
}

fn required<T: Clone>(v: Option<&T>, field: &str) -> Result<T, OpErr> {
    v.cloned()
        .ok_or_else(|| Refusal::field(field, "required").into())
}

fn revision<T>(op: &EntitySetupOp, ctx: &OpCtx<'_>, input: T) -> Revision<T> {
    Revision {
        expected_version: op.expected_version,
        effective_from: op
            .effective_from
            .clone()
            .or(ctx.effective_from.map(str::to_owned)),
        reason_code: op
            .reason_code
            .clone()
            .or(ctx.reason_code.map(str::to_owned)),
        input,
    }
}

/// Run `op` as `actor` (its own command id). The caller holds a savepoint.
pub(crate) async fn exec(
    tx: &mut Tx<'_>,
    ctx: &OpCtx<'_>,
    op: &EntitySetupOp,
) -> Result<OpDone, OpErr> {
    let (actor, admitted) = (ctx.actor, ctx.admitted);
    match op.op.as_deref().unwrap_or_default() {
        CREATE_ENTITY => {
            let input = required(op.entity.as_ref(), "entity")?;
            if let Some(found) = existing_entity(tx, &input, ctx.today).await? {
                return Err(exists(found));
            }
            let (id, warnings, event) = create_entity_in_tx(tx, actor, admitted, &input).await?;
            Ok(created("legal_entity", id, id, warnings, vec![event]))
        }
        REVISE_ENTITY => {
            let id = required(op.id.as_ref(), "id")?;
            let rev: LegalEntityRevision =
                revision(op, ctx, required(op.entity.as_ref(), "entity")?);
            let before = crate::legal_entity::one(tx, id, None, true).await?;
            let identity: (Option<String>, Option<String>) =
                sqlx::query_as("SELECT biz_kind, crn FROM legal_entities WHERE id = $1")
                    .bind(id)
                    .fetch_one(tx.as_mut())
                    .await?;
            let (warnings, event) = revise_entity_in_tx(tx, actor, admitted, id, &rev).await?;
            let after = crate::legal_entity::one(tx, id, None, true).await?;
            // diffs the latest state; a backdated revise under a later
            // scheduled revision reads UNCHANGED. Diff as of `effective_from` if that matters.
            let latest = |v: &console_entity_application::LegalEntityView| {
                state(v.scheduled.last().or(v.current.as_ref()), [])
            };
            let (version, revision_id) = head(tx, "legal_entity", id).await?;
            Ok(OpDone {
                target: id,
                entity: id,
                created: false,
                version,
                changes: crate::history::diff(&latest(&before), &latest(&after)),
                warnings,
                step: json!({
                    "target_type": "legal_entity", "target_id": id, "created": false,
                    "after_version": version, "after_revision_id": revision_id,
                    "before_needs_confirmation": before.needs_confirmation,
                    "before_biz_kind": identity.0, "before_crn": identity.1,
                }),
                events: vec![event],
            })
        }
        CREATE_WORKPLACE => {
            let entity = match (op.legal_entity_id, op.entity_ref.as_deref()) {
                (Some(id), None) => id,
                (None, Some(r)) => *ctx
                    .refs
                    .get(r)
                    .ok_or_else(|| Refusal::field("entity_ref", "unknown_ref"))?,
                _ => return Err(Refusal::field("legal_entity_id", "one_parent_required").into()),
            };
            let input = required(op.workplace.as_ref(), "workplace")?;
            if let Some(found) = existing_workplace(tx, entity, input.name.as_deref()).await? {
                return Err(exists(found));
            }
            let cmd = CreateWorkplace {
                input,
                is_primary: op.is_primary,
                is_head_office: op.is_head_office,
                default_branch_id: None,
                // the bulk sheet has no kind column; a kind is set per 사업장 afterwards.
                kind_code: None,
            };
            let (id, events) =
                create_workplace_in_tx(tx, actor, admitted, entity, &cmd, ctx.port).await?;
            Ok(created("workplace", id, entity, Vec::new(), events))
        }
        REVISE_WORKPLACE => {
            let id = required(op.id.as_ref(), "id")?;
            let rev: WorkplaceRevision =
                revision(op, ctx, required(op.workplace.as_ref(), "workplace")?);
            let entity: Uuid =
                sqlx::query_scalar("SELECT legal_entity_id FROM workplaces WHERE id = $1")
                    .bind(id)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| Refusal::not_found("workplace_not_found"))?;
            let before = workplace_state(tx, entity, id).await?;
            let (_, events) =
                revise_workplace_in_tx(tx, actor, admitted, id, rev, ctx.port).await?;
            if op.is_primary == Some(true) || op.is_head_office == Some(true) {
                set_roles_on_create(
                    tx,
                    entity,
                    id,
                    op.is_primary,
                    op.is_head_office,
                    None,
                    false,
                )
                .await?;
            }
            let after = workplace_state(tx, entity, id).await?;
            let (version, revision_id) = head(tx, "workplace", id).await?;
            Ok(OpDone {
                target: id,
                entity,
                created: false,
                version,
                changes: crate::history::diff(&before.1, &after.1),
                warnings: Vec::new(),
                step: json!({
                    "target_type": "workplace", "target_id": id, "created": false,
                    "after_version": version, "after_revision_id": revision_id,
                    "before_needs_confirmation": before.0,
                }),
                events,
            })
        }
        _ => Err(Refusal::field("op", "invalid_choice").into()),
    }
}

fn created(
    kind: &str,
    id: Uuid,
    entity: Uuid,
    warnings: Vec<Warning>,
    events: Vec<AuditEvent>,
) -> OpDone {
    OpDone {
        target: id,
        entity,
        created: true,
        version: 1,
        changes: Vec::new(),
        warnings,
        step: json!({ "target_type": kind, "target_id": id, "created": true, "after_version": 1 }),
        events,
    }
}

fn exists(found: Uuid) -> OpErr {
    OpErr::Refused(
        Refusal::conflict(
            "already_exists",
            "a record with this identifier or name already exists",
        )
        .with_remedy("revise_existing"),
        Some(found),
    )
}
