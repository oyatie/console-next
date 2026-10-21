//! Bulk 법인 · 사업장 batch (MR-29): the request's shape, its digest, the
//! op savepoints and the 대표 / 본점 role pins (`entity_batch`).

use std::collections::BTreeSet;

use console_entity_application::EntitySetupBatch;
use console_entity_domain::{FieldIssue, Refusal};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::entity_batch_ops::{REVISE_ENTITY, REVISE_WORKPLACE};
use crate::{PgEntityError, Tx};

/// Request guard (not a policy value): a group's sheet is tens of rows.
const MAX_OPS: usize = 1000;

/// Close the op's savepoint, undoing its writes when `discard`.
pub(crate) async fn savepoint_end(tx: &mut Tx<'_>, discard: bool) -> Result<(), PgEntityError> {
    if discard {
        sqlx::query("ROLLBACK TO SAVEPOINT entity_setup_op")
            .execute(tx.as_mut())
            .await?;
    }
    sqlx::query("RELEASE SAVEPOINT entity_setup_op")
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

/// 422 naming every malformed op at once: unknown verb, duplicate `ref`, the
/// same record twice (an undo pins one after-image per record), too many ops.
pub(crate) fn check_shape(batch: &EntitySetupBatch) -> Result<(), Refusal> {
    let mut issues: Vec<FieldIssue> = Vec::new();
    if batch.ops.is_empty() || batch.ops.len() > MAX_OPS {
        issues.push(FieldIssue {
            field: "ops".into(),
            code: if batch.ops.is_empty() {
                "required"
            } else {
                "too_many"
            },
        });
    }
    let (mut refs, mut targets) = (BTreeSet::new(), BTreeSet::new());
    for (i, op) in batch.ops.iter().enumerate() {
        if let Some(r) = &op.reference
            && !refs.insert(r.as_str())
        {
            issues.push(FieldIssue {
                field: format!("ops[{i}].ref"),
                code: "duplicate_ref",
            });
        }
        let revise = matches!(op.op.as_deref(), Some(REVISE_ENTITY | REVISE_WORKPLACE));
        if let (true, Some(id)) = (revise, op.id)
            && !targets.insert(id)
        {
            issues.push(FieldIssue {
                field: format!("ops[{i}].id"),
                code: "duplicate_target",
            });
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(Refusal::fields(issues))
    }
}

/// An op's refusal, its fields prefixed `ops[i].` (a fieldless one names the op).
pub(crate) fn at_op(index: usize, mut refusal: Refusal) -> Refusal {
    if refusal.fields.is_empty() {
        refusal.fields.push(FieldIssue {
            field: format!("ops[{index}]"),
            code: refusal.code,
        });
    } else {
        for f in &mut refusal.fields {
            f.field = format!("ops[{index}].{}", f.field);
        }
    }
    refusal
}

/// sha256 over the batch, each revised record's newest version, today and
/// the phase (a 운영 시작 in between forces a fresh preview).
pub(crate) async fn digest(
    tx: &mut Tx<'_>,
    batch: &EntitySetupBatch,
    phase: &str,
    today: time::Date,
) -> Result<String, PgEntityError> {
    let ids: Vec<Uuid> = batch.ops.iter().filter_map(|op| op.id).collect();
    let versions: Value = sqlx::query_scalar(
        "SELECT COALESCE(jsonb_object_agg(id, v), '{}'::jsonb) FROM ( \
           SELECT legal_entity_id AS id, max(version) AS v FROM legal_entity_revisions WHERE legal_entity_id = ANY($1) GROUP BY 1 \
           UNION ALL SELECT workplace_id, max(version) FROM workplace_revisions WHERE workplace_id = ANY($1) GROUP BY 1) t",
    )
    .bind(&ids)
    .fetch_one(tx.as_mut())
    .await?;
    let body = json!({ "batch": batch.digest_body(), "versions": versions, "phase": phase, "today": today.to_string() });
    Ok(
        sqlx::query_scalar("SELECT encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex')")
            .bind(body)
            .fetch_one(tx.as_mut())
            .await?,
    )
}

/// Existing 법인 whose 대표 / 본점 사업장 a workplace op may move (a 법인 the
/// batch creates is voided whole by an undo: no roles to pin).
pub(crate) async fn touched_entities(
    tx: &mut Tx<'_>,
    batch: &EntitySetupBatch,
) -> Result<Vec<Uuid>, PgEntityError> {
    let mut entities: BTreeSet<Uuid> = batch
        .ops
        .iter()
        .filter_map(|op| op.legal_entity_id)
        .collect();
    let workplaces: Vec<Uuid> = batch
        .ops
        .iter()
        .filter(|op| op.op.as_deref() == Some(REVISE_WORKPLACE))
        .filter_map(|op| op.id)
        .collect();
    let owners: Vec<Uuid> =
        sqlx::query_scalar("SELECT DISTINCT legal_entity_id FROM workplaces WHERE id = ANY($1)")
            .bind(&workplaces)
            .fetch_all(tx.as_mut())
            .await?;
    entities.extend(owners);
    Ok(entities.into_iter().collect())
}

/// The 대표 / 본점 roles of `entities`, in order.
pub(crate) async fn roles(tx: &mut Tx<'_>, entities: &[Uuid]) -> Result<Vec<Value>, PgEntityError> {
    Ok(sqlx::query_scalar(
        "SELECT jsonb_build_object('id', id, 'primary_workplace_id', primary_workplace_id, \
           'head_office_workplace_id', head_office_workplace_id, 'head_office_has_no_workplace', head_office_has_no_workplace) \
         FROM legal_entities WHERE id = ANY($1) ORDER BY id",
    )
    .bind(entities)
    .fetch_all(tx.as_mut())
    .await?)
}
