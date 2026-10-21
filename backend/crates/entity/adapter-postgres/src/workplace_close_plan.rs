//! UX-R2 ENDS (company-01, worst-case-18; decisions #21): the 법인 · 사업장
//! half of a 사업장 close job, reads. HR's `lifecycle::close_plan`
//! orchestrates the job in one transaction: it reads who and what is still
//! at the 사업장 here, records each person's 전근 or 퇴직 through the lifecycle
//! path, then calls the writes (`workplace_close_apply`, re-exported here) to
//! move or dissolve each 부서 and to close the 사업장 itself — the same checks
//! and writes a direct close makes.

use console_entity_domain::Refusal;
use console_orgchange_domain::{TreeEntry, tree_order};
use serde::Serialize;
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

use crate::org_tree;
pub use crate::workplace_close_apply::{
    CloseActor, claim_plan, close, dissolve, finish_plan, job_event, reparent,
};
use crate::{PgEntityError, Tx};

/// The 사업장 a close plan is for, as it is now.
#[derive(Debug, Clone, Serialize)]
pub struct CloseScope {
    pub workplace_id: Uuid,
    pub legal_entity_id: Uuid,
    /// Its own (SITE) unit; `None` for a legacy 사업장 without one.
    pub site_org_unit_id: Option<Uuid>,
    pub closed_on: Option<time::Date>,
    /// It is its 법인's 대표 사업장 or 본점: it does not close alone.
    pub holds_entity_role: bool,
}

/// An active 부서 under the 사업장 (any depth).
#[derive(Debug, Clone, Serialize)]
pub struct ScopeUnit {
    pub org_unit_id: Uuid,
    pub name: String,
    pub parent_org_unit_id: Option<Uuid>,
    pub version: i64,
}

/// Someone who has not left and is still at the 사업장: placed there now (or
/// later), or bound to its own unit or a 부서 under it.
#[derive(Debug, Clone, Serialize)]
pub struct ClosePerson {
    pub employee_id: Uuid,
    pub name: String,
    pub employee_number: Option<String>,
    pub org_unit_id: Option<Uuid>,
    pub hire_date: Option<String>,
}

/// Read the 사업장 (locked `FOR UPDATE` when `lock`, as every 사업장 write
/// locks it). 404 `workplace_not_found`; 409 `workplace_voided`.
///
/// # Errors
/// Those refusals, or database faults.
pub async fn scope(
    tx: &mut Tx<'_>,
    workplace: Uuid,
    lock: bool,
) -> Result<CloseScope, PgEntityError> {
    if lock {
        crate::workplace::lock_workplace(tx, workplace).await?;
    }
    let row = sqlx::query(
        "SELECT w.legal_entity_id, w.closed_on, w.voided_at IS NOT NULL AS voided, \
                (e.primary_workplace_id = w.id OR e.head_office_workplace_id = w.id) IS TRUE AS role, \
                (SELECT p.org_unit_id FROM org_unit_placements p WHERE p.workplace_id = w.id \
                   AND p.represents_workplace AND p.valid_to IS NULL) AS site \
         FROM workplaces w JOIN legal_entities e ON e.id = w.legal_entity_id WHERE w.id = $1",
    )
    .bind(workplace)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| Refusal::not_found("workplace_not_found"))?;
    if row.try_get::<bool, _>("voided")? {
        return Err(Refusal::conflict("workplace_voided", "the workplace was voided").into());
    }
    Ok(CloseScope {
        workplace_id: workplace,
        legal_entity_id: row.try_get("legal_entity_id")?,
        site_org_unit_id: row.try_get("site")?,
        closed_on: row.try_get("closed_on")?,
        holds_entity_role: row.try_get("role")?,
    })
}

/// Every active 부서 under the SITE unit `site` (the SITE unit excluded),
/// with its parent and version, in the chart's tree order (parents first).
///
/// # Errors
/// Database faults.
pub async fn units_under(tx: &mut Tx<'_>, site: Uuid) -> Result<Vec<ScopeUnit>, PgEntityError> {
    let ids = org_tree::subtree(tx, &[site]).await?;
    let positions: HashMap<Uuid, i32> = sqlx::query_as(
        "SELECT org_unit_id, position FROM org_unit_positions WHERE org_unit_id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .collect();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids.into_iter().filter(|id| *id != site) {
        if let Some(head) = org_tree::head(tx, id).await? {
            out.push(ScopeUnit {
                org_unit_id: id,
                name: head.name().to_owned(),
                parent_org_unit_id: head.parent(),
                version: head.version,
            });
        }
    }
    let order = tree_order(
        &out.iter()
            .map(|u| TreeEntry {
                id: u.org_unit_id,
                parent: u.parent_org_unit_id,
                position: positions.get(&u.org_unit_id).copied(),
                name: &u.name,
            })
            .collect::<Vec<_>>(),
    );
    let mut by_id: HashMap<Uuid, ScopeUnit> = out.into_iter().map(|u| (u.org_unit_id, u)).collect();
    Ok(order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect())
}

/// Everyone a close must plan for: not EXITED, and placed at the 사업장 past
/// `today`, or bound to one of `units` (its own unit and the 부서 under it).
///
/// # Errors
/// Database faults.
pub async fn people_at(
    tx: &mut Tx<'_>,
    workplace: Uuid,
    units: &[Uuid],
    today: time::Date,
) -> Result<Vec<ClosePerson>, PgEntityError> {
    let rows = sqlx::query(
        "SELECT e.id, e.name, e.employee_number, e.org_unit_id, to_char(e.hire_on, 'YYYY-MM-DD') AS hire_date \
         FROM employees e WHERE e.employment_status <> 'EXITED' AND (e.org_unit_id = ANY($2) OR EXISTS ( \
           SELECT 1 FROM employment_assignments a WHERE a.employee_id = e.id AND a.superseded_at IS NULL \
             AND a.workplace_id = $1 AND (a.valid_to IS NULL OR a.valid_to > $3))) \
         ORDER BY e.org_unit_id NULLS FIRST, e.name, e.id",
    )
    .bind(workplace)
    .bind(units)
    .bind(today)
    .fetch_all(tx.as_mut())
    .await?;
    rows.iter()
        .map(|r| {
            Ok(ClosePerson {
                employee_id: r.try_get("id")?,
                name: r.try_get("name")?,
                employee_number: r.try_get("employee_number")?,
                org_unit_id: r.try_get("org_unit_id")?,
                hire_date: r.try_get("hire_date")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(Into::into)
}

/// The 사업장 (and its 법인) of a unit that is open: the one its nearest SITE
/// ancestor (or itself) represents. `None` when it sits at no open 사업장.
///
/// # Errors
/// Database faults.
pub async fn open_workplace_of(
    tx: &mut Tx<'_>,
    unit: Uuid,
) -> Result<Option<(Uuid, Uuid)>, PgEntityError> {
    let Some(workplace) = org_tree::workplace_of(tx, unit).await? else {
        return Ok(None);
    };
    if !org_tree::workplace_open(tx, workplace).await? {
        return Ok(None);
    }
    let entity: Uuid = sqlx::query_scalar("SELECT legal_entity_id FROM workplaces WHERE id = $1")
        .bind(workplace)
        .fetch_one(tx.as_mut())
        .await?;
    Ok(Some((workplace, entity)))
}

/// Whether `unit` is an active unit.
///
/// # Errors
/// Database faults.
pub async fn unit_active(tx: &mut Tx<'_>, unit: Uuid) -> Result<bool, PgEntityError> {
    Ok(org_tree::head(tx, unit).await?.is_some_and(|h| h.active()))
}
