//! 회사 구조 labels (decisions #18, #21; review R15, R16, R17): a 사업장's
//! code and the sibling order of 법인, 사업장 and 부서. Labels are written in
//! place in both phases and audited (onboarding-and-migration §7.2); the
//! phase is still admitted so the audit row says SETUP or GOVERNED.

use console_entity_application::{
    Actor, ReorderStructure, Saved, SetWorkplaceCode, StructureOrder, StructureParent,
    WorkplaceView,
};
use console_entity_domain::structure_code::structure_code;
use console_entity_domain::{Refusal, Warning};
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use crate::command::{Outcome, claim, finish};
use crate::workplace::{lock_workplace, one_view};
use crate::{PgEntityError, PgEntityStore, Tx, admit, audit, org_tree, today_kst};

/// The children of `parent` today, in their current order.
async fn children(tx: &mut Tx<'_>, parent: &StructureParent) -> Result<Vec<Uuid>, PgEntityError> {
    let ids = match (
        parent.legal_entity_id,
        parent.workplace_id,
        parent.org_unit_id,
    ) {
        // The tenant's 법인, as the entity reads list them (`read::entities_at`).
        (None, None, None) => {
            sqlx::query_scalar(
                "SELECT id FROM legal_entities WHERE voided_at IS NULL \
                 ORDER BY sort_order NULLS LAST, created_at, id",
            )
            .fetch_all(tx.as_mut())
            .await?
        }
        (Some(entity), None, None) => {
            sqlx::query_scalar(
                "SELECT id FROM workplaces WHERE legal_entity_id = $1 AND voided_at IS NULL \
                 ORDER BY sort_order NULLS LAST, created_at, id",
            )
            .bind(entity)
            .fetch_all(tx.as_mut())
            .await?
        }
        (None, Some(workplace), None) => {
            let site: Option<Uuid> = sqlx::query_scalar(
                "SELECT org_unit_id FROM org_unit_placements \
                 WHERE workplace_id = $1 AND represents_workplace AND valid_to IS NULL",
            )
            .bind(workplace)
            .fetch_optional(tx.as_mut())
            .await?;
            match site {
                Some(site) => units_under(tx, site).await?,
                None => Vec::new(),
            }
        }
        (None, None, Some(unit)) => units_under(tx, unit).await?,
        _ => return Err(Refusal::field("legal_entity_id", "one_parent_required").into()),
    };
    Ok(ids)
}

async fn units_under(tx: &mut Tx<'_>, parent: Uuid) -> Result<Vec<Uuid>, PgEntityError> {
    Ok(sqlx::query_scalar(
        "SELECT h.org_unit_id FROM (SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes \
           FROM org_unit_revisions ORDER BY org_unit_id, version DESC) h \
         LEFT JOIN org_unit_positions p ON p.org_unit_id = h.org_unit_id \
         WHERE h.attributes->>'parent_id' = $1::text \
           AND h.attributes->>'status' IS DISTINCT FROM 'dissolved' \
           AND h.attributes->>'kind' IN ('department', 'team') \
         ORDER BY p.position NULLS LAST, h.attributes->>'name' COLLATE \"C\", h.org_unit_id",
    )
    .bind(parent)
    .fetch_all(tx.as_mut())
    .await?)
}

impl PgEntityStore {
    /// Set (or clear) a 사업장's code. A code a closed or voided 사업장 had
    /// is accepted with the warning `code_reused` (R17).
    ///
    /// # Errors
    /// `workplace_not_found`, `workplace_voided`, `code: invalid_format | code_taken`.
    pub async fn set_workplace_code(
        &self,
        actor: &Actor,
        id: Uuid,
        cmd: SetWorkplaceCode,
    ) -> Result<Saved<WorkplaceView>, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let replayed = claim(tx, &actor, "workplace.code", json!({ "workplace": id, "input": cmd })).await?;
                if let Some(done) = replayed {
                    let (entity, _, _) = lock_workplace(tx, id).await?;
                    let today = today_kst(tx).await?;
                    let record = one_view(tx, entity, id, today).await?;
                    let change_mode = done.change_mode.unwrap_or_default();
                    return Ok((Saved { record, warnings: Vec::new(), change_mode }, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let (entity, _, _) = lock_workplace(tx, id).await?;
                let code = structure_code("code", cmd.code.as_deref())?;
                let mut warnings = Vec::new();
                if let Some(code) = &code {
                    // (open taken, held before by a closed or voided 사업장)
                    let (taken, reused): (bool, bool) = sqlx::query_as(
                        "SELECT COALESCE(bool_or(voided_at IS NULL AND closed_on IS NULL), false), count(*) > 0 \
                         FROM workplaces WHERE code = $1 AND id <> $2",
                    )
                    .bind(code)
                    .bind(id)
                    .fetch_one(tx.as_mut())
                    .await?;
                    if taken {
                        return Err(Refusal::field("code", "code_taken").into());
                    }
                    if reused {
                        warnings.push(Warning { field: "code".into(), code: "code_reused" });
                    }
                }
                let previous: Option<String> = sqlx::query_scalar("SELECT code FROM workplaces WHERE id = $1")
                    .bind(id)
                    .fetch_one(tx.as_mut())
                    .await?;
                sqlx::query("UPDATE workplaces SET code = $2 WHERE id = $1")
                    .bind(id)
                    .bind(&code)
                    .execute(tx.as_mut())
                    .await?;
                let event = audit(&actor, "workplace.code", "workplace", id, admitted,
                    json!({ "code": code, "previous": previous }))?;
                let mode: String = admitted.mode.as_str().into();
                finish(tx, &actor, &Outcome { target: Some(id), change_mode: Some(mode.clone()), count: None }).await?;
                let today = today_kst(tx).await?;
                let record = one_view(tx, entity, id, today).await?;
                Ok((Saved { record, warnings, change_mode: mode }, vec![event]))
            })
        })
        .await
    }

    /// Put one parent's children in the given order: the tenant's 법인 (no
    /// parent named), 사업장 of a 법인, or 부서 directly in a 사업장 or under
    /// a 부서. `children` must name every current child exactly once, and
    /// `expected_children`, when given, the current order (else 409
    /// `children_changed`: reload).
    ///
    /// # Errors
    /// `one_parent_required`, `parent_not_found`, `children_changed`, or database faults.
    pub async fn reorder_structure(
        &self,
        actor: &Actor,
        cmd: ReorderStructure,
    ) -> Result<StructureOrder, PgEntityError> {
        let actor = actor.clone();
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let parent = cmd.parent.clone();
                let named = [parent.legal_entity_id, parent.workplace_id, parent.org_unit_id];
                if named.iter().flatten().count() > 1 {
                    return Err(Refusal::field("legal_entity_id", "one_parent_required").into());
                }
                let tenant = named.iter().all(Option::is_none);
                let parent_id = named.into_iter().flatten().next().unwrap_or(*actor.org.as_uuid());
                if let Some(done) = claim(tx, &actor, "org_structure.reorder", json!(cmd)).await? {
                    let children = children(tx, &parent).await?;
                    let change_mode = done.change_mode.unwrap_or_default();
                    return Ok((StructureOrder { children, change_mode }, vec![]));
                }
                let admitted = admit(tx, WriteClass::EntityStructure).await?;
                let known: bool = tenant || sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM legal_entities WHERE id = $1 AND voided_at IS NULL) \
                         OR EXISTS (SELECT 1 FROM workplaces WHERE id = $1 AND voided_at IS NULL) \
                         OR EXISTS (SELECT 1 FROM org_unit_revisions WHERE org_unit_id = $1)",
                )
                .bind(parent_id)
                .fetch_one(tx.as_mut())
                .await?;
                if !known {
                    return Err(Refusal::not_found("parent_not_found").into());
                }
                // One lock per parent: two reorders of one sibling list queue.
                org_tree::lock_units(tx, &[parent_id]).await?;
                let current = children(tx, &parent).await?;
                let (mut had, mut wanted) = (current.clone(), cmd.children.clone());
                had.sort_unstable();
                wanted.sort_unstable();
                let stale = cmd.expected_children.as_ref().is_some_and(|seen| *seen != current);
                if had != wanted || stale {
                    return Err(Refusal::conflict(
                        "children_changed",
                        "the children changed since they were read; reload and reorder",
                    )
                    .with_remedy("reload")
                    .into());
                }
                let positions: Vec<i32> = (0..).take(cmd.children.len()).collect();
                if tenant {
                    sqlx::query(
                        "UPDATE legal_entities e SET sort_order = o.n FROM unnest($1::uuid[], $2::int[]) AS o(id, n) \
                         WHERE e.id = o.id",
                    )
                    .bind(&cmd.children)
                    .bind(&positions)
                    .execute(tx.as_mut())
                    .await?;
                } else if parent.legal_entity_id.is_some() {
                    sqlx::query(
                        "UPDATE workplaces w SET sort_order = o.n FROM unnest($1::uuid[], $2::int[]) AS o(id, n) \
                         WHERE w.id = o.id",
                    )
                    .bind(&cmd.children)
                    .bind(&positions)
                    .execute(tx.as_mut())
                    .await?;
                } else {
                    sqlx::query(
                        "INSERT INTO org_unit_positions (org_id, org_unit_id, position, updated_by) \
                         SELECT NULLIF(current_setting('app.current_org', true), '')::uuid, o.id, o.n, $3 \
                         FROM unnest($1::uuid[], $2::int[]) AS o(id, n) \
                         ON CONFLICT (org_id, org_unit_id) DO UPDATE \
                           SET position = EXCLUDED.position, updated_by = EXCLUDED.updated_by, updated_at = now()",
                    )
                    .bind(&cmd.children)
                    .bind(&positions)
                    .bind(*actor.user.as_uuid())
                    .execute(tx.as_mut())
                    .await?;
                }
                let target_type = if tenant { "tenant" } else if parent.legal_entity_id.is_some() { "legal_entity" } else if parent.workplace_id.is_some() { "workplace" } else { "org_unit" };
                let event = audit(&actor, "org_structure.reorder", target_type, parent_id, admitted,
                    json!({ "children": cmd.children }))?;
                let mode: String = admitted.mode.as_str().into();
                finish(tx, &actor, &Outcome { target: Some(parent_id), change_mode: Some(mode.clone()), count: None }).await?;
                Ok((StructureOrder { children: cmd.children, change_mode: mode }, vec![event]))
            })
        })
        .await
    }
}
