//! Reads over the canonical OrgUnit tree for setup 부서 changes: the current
//! head of a unit, its subtree, the 사업장 it sits in, who is placed in it,
//! and the one write that keeps people's 사업장 in step when a 부서 moves to
//! another 사업장. The tree is the latest `org_unit_revisions` row per unit
//! (RLS keeps it to the tenant).
//!
//! every walk re-reads the tenant's heads (DISTINCT ON over all
//! revisions); fine at setup scale (≈ 400 부서 in the P2b group), add a head
//! view or index if a tenant's tree grows past a few thousand units.

use console_entity_application::Actor;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::{PgEntityError, Tx};

/// The latest revision per unit, as a CTE named `heads`.
macro_rules! heads {
    () => {
        "heads AS (SELECT DISTINCT ON (org_unit_id) org_unit_id, version, attributes \
         FROM org_unit_revisions ORDER BY org_unit_id, version DESC)"
    };
}

/// A unit's current revision.
#[derive(Debug, Clone)]
pub(crate) struct Head {
    pub version: i64,
    pub attributes: Value,
}

impl Head {
    pub fn kind(&self) -> &str {
        self.attributes["kind"].as_str().unwrap_or_default()
    }
    pub fn active(&self) -> bool {
        self.attributes["status"] != "dissolved"
    }
    pub fn parent(&self) -> Option<Uuid> {
        self.attributes["parent_id"]
            .as_str()
            .and_then(|p| Uuid::parse_str(p).ok())
    }
    pub fn name(&self) -> &str {
        self.attributes["name"].as_str().unwrap_or_default()
    }
}

pub(crate) async fn head(tx: &mut Tx<'_>, id: Uuid) -> Result<Option<Head>, PgEntityError> {
    let row = sqlx::query(
        "SELECT version, attributes FROM org_unit_revisions WHERE org_unit_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?;
    Ok(match row {
        None => None,
        Some(r) => Some(Head {
            version: r.try_get("version")?,
            attributes: r.try_get("attributes")?,
        }),
    })
}

/// Lock the units for this transaction, in id order (one order for every
/// writer, so two batches over the same units queue instead of
/// deadlocking). Transaction-scoped advisory locks: the runtime role may not
/// row-lock `org_units`, and the canonical owner's revise takes none.
///
/// only setup 부서 writes take these; the 사업장 rename/void paths
/// write SITE units unlocked (one writer per 사업장 in practice).
pub(crate) async fn lock_units(tx: &mut Tx<'_>, ids: &[Uuid]) -> Result<(), PgEntityError> {
    let mut ids = ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('org_unit:' || id::text, 0)) \
         FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, n) ORDER BY n",
    )
    .bind(&ids)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(())
}

/// The active units at or under `roots`, deepest first (so a dissolve never
/// leaves an active child under a dissolved parent, and its undo, replayed in
/// reverse, restores parents first).
pub(crate) async fn subtree(tx: &mut Tx<'_>, roots: &[Uuid]) -> Result<Vec<Uuid>, PgEntityError> {
    let rows: Vec<(Uuid, i32)> = sqlx::query_as(concat!(
        "WITH RECURSIVE ",
        heads!(),
        ", down AS (SELECT org_unit_id, 0 AS depth FROM heads \
            WHERE org_unit_id = ANY($1) AND attributes->>'status' IS DISTINCT FROM 'dissolved' \
          UNION SELECT h.org_unit_id, d.depth + 1 FROM heads h JOIN down d ON h.attributes->>'parent_id' = d.org_unit_id::text \
            WHERE h.attributes->>'status' IS DISTINCT FROM 'dissolved' AND d.depth < 64) \
         SELECT org_unit_id, max(depth) FROM down GROUP BY org_unit_id ORDER BY max(depth) DESC, org_unit_id"
    ))
    .bind(roots)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows.into_iter().map(|(id, _)| id).collect())
}

/// Whether `ancestor` is `unit` or one of its ancestors (a move under it
/// would make a cycle).
pub(crate) async fn is_ancestor(
    tx: &mut Tx<'_>,
    ancestor: Uuid,
    unit: Uuid,
) -> Result<bool, PgEntityError> {
    Ok(sqlx::query_scalar(concat!(
        "WITH RECURSIVE ",
        heads!(),
        ", up AS (SELECT org_unit_id, attributes, 0 AS depth FROM heads WHERE org_unit_id = $2 \
          UNION SELECT h.org_unit_id, h.attributes, u.depth + 1 FROM heads h JOIN up u \
            ON h.org_unit_id::text = u.attributes->>'parent_id' WHERE u.depth < 64) \
         SELECT EXISTS (SELECT 1 FROM up WHERE org_unit_id = $1)"
    ))
    .bind(ancestor)
    .bind(unit)
    .fetch_one(tx.as_mut())
    .await?)
}

/// The 사업장 a unit sits in: the one its nearest SITE ancestor (or itself)
/// represents. `None` for a legacy unit under no 사업장.
pub(crate) async fn workplace_of(
    tx: &mut Tx<'_>,
    unit: Uuid,
) -> Result<Option<Uuid>, PgEntityError> {
    Ok(sqlx::query_scalar(concat!(
        "WITH RECURSIVE ",
        heads!(),
        ", up AS (SELECT org_unit_id, attributes, 0 AS depth FROM heads WHERE org_unit_id = $1 \
          UNION SELECT h.org_unit_id, h.attributes, u.depth + 1 FROM heads h JOIN up u \
            ON h.org_unit_id::text = u.attributes->>'parent_id' WHERE u.depth < 64) \
         SELECT p.workplace_id FROM up JOIN org_unit_placements p ON p.org_unit_id = up.org_unit_id \
           AND p.represents_workplace AND p.valid_to IS NULL ORDER BY up.depth LIMIT 1"
    ))
    .bind(unit)
    .fetch_optional(tx.as_mut())
    .await?)
}

/// Whether the 사업장 (and its 법인) is open for new 부서 and people.
pub(crate) async fn workplace_open(
    tx: &mut Tx<'_>,
    workplace: Uuid,
) -> Result<bool, PgEntityError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM workplaces w JOIN legal_entities e ON e.id = w.legal_entity_id \
           WHERE w.id = $1 AND w.voided_at IS NULL AND w.closed_on IS NULL \
             AND e.voided_at IS NULL AND e.closed_on IS NULL)",
    )
    .bind(workplace)
    .fetch_one(tx.as_mut())
    .await?)
}

/// People placed in any of `units` who have not left.
pub(crate) async fn members(tx: &mut Tx<'_>, units: &[Uuid]) -> Result<i64, PgEntityError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM employees WHERE org_unit_id = ANY($1) AND entity_employed_on(entity_today(), hire_on, exit_on, employment_status)",
    )
    .bind(units)
    .fetch_one(tx.as_mut())
    .await?)
}

/// Whether an active sibling under `parent` already has `name` (compared
/// trimmed and case-folded), other than `except`.
pub(crate) async fn sibling_taken(
    tx: &mut Tx<'_>,
    parent: Uuid,
    name: &str,
    except: Option<Uuid>,
) -> Result<bool, PgEntityError> {
    Ok(sqlx::query_scalar(concat!(
        "WITH ",
        heads!(),
        " SELECT EXISTS (SELECT 1 FROM heads WHERE attributes->>'parent_id' = $1::text \
            AND attributes->>'status' IS DISTINCT FROM 'dissolved' \
            AND lower(btrim(attributes->>'name')) = lower(btrim($2)) \
            AND org_unit_id IS DISTINCT FROM $3)"
    ))
    .bind(parent)
    .bind(name)
    .bind(except)
    .fetch_one(tx.as_mut())
    .await?)
}

/// A 부서 moved from one 사업장 to another: the people in it (and under it)
/// who have not left get their open placement at `from` corrected to `to`
/// (and its 법인), from the same first day. The old row is superseded, never
/// rewritten (0259). Setup only: after go-live a move is a governed 전보.
pub(crate) async fn rebind_members(
    tx: &mut Tx<'_>,
    actor: &Actor,
    command: Uuid,
    units: &[Uuid],
    from: Uuid,
    to: Uuid,
) -> Result<u64, PgEntityError> {
    let rows = sqlx::query(
        "WITH people AS (SELECT id FROM employees WHERE org_unit_id = ANY($1) AND entity_employed_on(entity_today(), hire_on, exit_on, employment_status) \
                         ORDER BY id FOR UPDATE) \
         SELECT a.id, a.employee_id, a.valid_from FROM employment_assignments a JOIN people p ON p.id = a.employee_id \
         WHERE a.workplace_id = $2 AND a.superseded_at IS NULL AND a.valid_to IS NULL",
    )
    .bind(units)
    .bind(from)
    .fetch_all(tx.as_mut())
    .await?;
    let entity: Uuid = sqlx::query_scalar("SELECT legal_entity_id FROM workplaces WHERE id = $1")
        .bind(to)
        .fetch_one(tx.as_mut())
        .await?;
    for row in &rows {
        sqlx::query("UPDATE employment_assignments SET superseded_at = now() WHERE id = $1")
            .bind(row.try_get::<Uuid, _>("id")?)
            .execute(tx.as_mut())
            .await?;
        sqlx::query(
            "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, \
               cause, actor_id, command_id) \
             VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, $3, $4, 'CORRECTION', $5, $6)",
        )
        .bind(row.try_get::<Uuid, _>("employee_id")?)
        .bind(entity)
        .bind(to)
        .bind(row.try_get::<time::Date, _>("valid_from")?)
        .bind(*actor.user.as_uuid())
        .bind(command)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(rows.len() as u64)
}
