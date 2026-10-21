//! A close plan checked against the 사업장 as it is, fail-closed: a line for
//! every person and for every 부서 directly under it, each target an active
//! unit at another open 사업장 of the same 법인 (or a 부서 the plan itself
//! moves there). Writes nothing; returns the lines to store or every refusal.

use std::collections::{BTreeMap, BTreeSet};

use console_entity_adapter_postgres::workplace_close_plan::{
    ClosePerson, CloseScope, ScopeUnit, open_workplace_of, unit_active,
};
use console_kernel_core::OrgId;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::exits::checked_reason;
use super::rows::NewLine;
use super::types::{
    PersonAction, UnitAction, WorkplaceClosePlanRequest, entity_error, plan_refused,
};
use crate::HrError;

pub(super) type Tx<'a, 'b> = &'a mut Transaction<'b, Postgres>;

/// What the 사업장 holds now.
pub(crate) struct Holdings<'a> {
    pub scope: &'a CloseScope,
    pub units: &'a [ScopeUnit],
    pub people: &'a [ClosePerson],
}

/// The checked plan: its lines, units first (moves, then dissolutions), then people.
pub(crate) async fn check(
    tx: Tx<'_, '_>,
    org: OrgId,
    at: &Holdings<'_>,
    body: &WorkplaceClosePlanRequest,
) -> Result<Vec<NewLine>, HrError> {
    let site = at.scope.site_org_unit_id;
    let top: BTreeSet<Uuid> = at
        .units
        .iter()
        .filter(|u| u.parent_org_unit_id == site)
        .map(|u| u.org_unit_id)
        .collect();
    let here: BTreeSet<Uuid> = at.people.iter().map(|p| p.employee_id).collect();
    let mut refusals = Vec::new();
    let mut seen = BTreeSet::new();
    for line in &body.units {
        if !top.contains(&line.org_unit_id) {
            refusals.push(json!({ "org_unit_id": line.org_unit_id, "code": "line_not_in_plan" }));
        } else if !seen.insert(line.org_unit_id) {
            refusals.push(json!({ "org_unit_id": line.org_unit_id, "code": "line_duplicate" }));
        }
    }
    for line in &body.people {
        if !here.contains(&line.employee_id) {
            refusals.push(json!({ "employee_id": line.employee_id, "code": "line_not_in_plan" }));
        } else if !seen.insert(line.employee_id) {
            refusals.push(json!({ "employee_id": line.employee_id, "code": "line_duplicate" }));
        }
    }
    let missing: Vec<Value> = top
        .iter()
        .filter(|u| !seen.contains(u))
        .map(|u| json!({ "org_unit_id": u, "code": "line_missing" }))
        .chain(
            here.iter()
                .filter(|p| !seen.contains(p))
                .map(|p| json!({ "employee_id": p, "code": "line_missing" })),
        )
        .collect();
    if !missing.is_empty() {
        // Fail closed: nothing applies while anyone or any 부서 has no line.
        return Err(plan_refused(
            "close_plan_incomplete",
            missing.into_iter().chain(refusals).collect(),
        ));
    }
    let alternatives = open_alternatives(tx, at.scope).await?;
    // Where each unit under the 사업장 is on the day: a moved subtree's
    // 사업장 is its destination's; a dissolved one is nowhere.
    let mut moved_to: BTreeMap<Uuid, Uuid> = BTreeMap::new();
    let mut lines = Vec::new();
    for line in body.units.iter().filter(|l| l.action == UnitAction::Move) {
        let Some(parent) = line.to_parent_id else {
            refusals
                .push(json!({ "org_unit_id": line.org_unit_id, "code": "to_parent_id_required" }));
            continue;
        };
        match target_at(tx, at, parent, &moved_to).await? {
            Ok(workplace) => {
                for u in subtree_of(at.units, line.org_unit_id) {
                    moved_to.insert(u, workplace);
                }
                lines.push(NewLine {
                    employee_id: None,
                    org_unit_id: Some(line.org_unit_id),
                    action: "MOVE",
                    target_unit_id: Some(parent),
                    target_workplace_id: None,
                    exit_reason_code: None,
                    exit_case_id: None,
                    lifecycle_event_id: None,
                    group_transfer: None,
                });
            }
            Err(code) => refusals.push(refusal(
                "org_unit_id",
                line.org_unit_id,
                code,
                &alternatives,
            )),
        }
    }
    for line in body
        .units
        .iter()
        .filter(|l| l.action == UnitAction::Dissolve)
    {
        lines.push(NewLine {
            employee_id: None,
            org_unit_id: Some(line.org_unit_id),
            action: "DISSOLVE",
            target_unit_id: None,
            target_workplace_id: None,
            exit_reason_code: None,
            exit_case_id: None,
            lifecycle_event_id: None,
            group_transfer: None,
        });
    }
    for line in &body.people {
        let e = line.employee_id;
        match line.action {
            PersonAction::GroupTransfer => {
                match super::group::line(tx, at, line, &body.closed_on).await? {
                    Ok(l) => lines.push(l),
                    Err(r) => refusals.push(r),
                }
            }
            PersonAction::Exit => {
                match checked_reason(tx, org, e, line.exit_reason_code.as_deref()).await? {
                    Ok(code) => lines.push(NewLine {
                        employee_id: Some(e),
                        org_unit_id: None,
                        action: "EXIT",
                        target_unit_id: None,
                        target_workplace_id: None,
                        exit_reason_code: Some(code),
                        exit_case_id: None,
                        lifecycle_event_id: None,
                        group_transfer: None,
                    }),
                    Err(r) => refusals.push(r),
                }
            }
            PersonAction::Transfer => {
                let Some(unit) = line.to_org_unit_id else {
                    refusals.push(json!({ "employee_id": e, "code": "to_org_unit_id_required" }));
                    continue;
                };
                match target_at(tx, at, unit, &moved_to).await? {
                    Ok(workplace) => lines.push(NewLine {
                        employee_id: Some(e),
                        org_unit_id: None,
                        action: "TRANSFER",
                        target_unit_id: Some(unit),
                        target_workplace_id: Some(workplace),
                        exit_reason_code: None,
                        exit_case_id: None,
                        lifecycle_event_id: None,
                        group_transfer: None,
                    }),
                    Err(code) => refusals.push(refusal("employee_id", e, code, &alternatives)),
                }
            }
        }
    }
    if !refusals.is_empty() {
        return Err(plan_refused("close_plan_refused", refusals));
    }
    Ok(lines)
}

/// The 사업장 a 전근 target unit is at on the day, or why it cannot take
/// anyone: `org_unit_not_found` (not an active unit), `workplace_not_open`
/// (at no open 사업장, at this one, or dissolved with it),
/// `transfer_cross_entity` (another 법인's: a 전적, never a 전근).
async fn target_at(
    tx: Tx<'_, '_>,
    at: &Holdings<'_>,
    unit: Uuid,
    moved_to: &BTreeMap<Uuid, Uuid>,
) -> Result<Result<Uuid, &'static str>, HrError> {
    Ok(match target_of(tx, at, unit, moved_to).await? {
        Ok((_, entity)) if entity != at.scope.legal_entity_id => Err("transfer_cross_entity"),
        other => other.map(|(workplace, _)| workplace),
    })
}

/// The 사업장 and 법인 a target unit is at on the day (a unit the plan moves
/// stays in this 법인), or why it cannot take anyone.
pub(super) async fn target_of(
    tx: Tx<'_, '_>,
    at: &Holdings<'_>,
    unit: Uuid,
    moved_to: &BTreeMap<Uuid, Uuid>,
) -> Result<Result<(Uuid, Uuid), &'static str>, HrError> {
    if let Some(workplace) = moved_to.get(&unit) {
        return Ok(Ok((*workplace, at.scope.legal_entity_id)));
    }
    if Some(unit) == at.scope.site_org_unit_id || at.units.iter().any(|u| u.org_unit_id == unit) {
        return Ok(Err("workplace_not_open"));
    }
    if !unit_active(tx, unit).await.map_err(entity_error)? {
        return Ok(Err("org_unit_not_found"));
    }
    Ok(open_workplace_of(tx, unit)
        .await
        .map_err(entity_error)?
        .ok_or("workplace_not_open"))
}

/// The unit and every unit under it, from the 사업장's list.
fn subtree_of(units: &[ScopeUnit], root: Uuid) -> Vec<Uuid> {
    let mut out = vec![root];
    let mut i = 0;
    while i < out.len() {
        let parent = out[i];
        out.extend(
            units
                .iter()
                .filter(|u| u.parent_org_unit_id == Some(parent))
                .map(|u| u.org_unit_id),
        );
        i += 1;
    }
    out
}

/// The 법인's other open 사업장: where a refused target could go instead.
async fn open_alternatives(tx: Tx<'_, '_>, scope: &CloseScope) -> Result<Vec<Uuid>, HrError> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM workplaces WHERE legal_entity_id = $1 AND id <> $2 AND voided_at IS NULL AND closed_on IS NULL ORDER BY id",
    )
    .bind(scope.legal_entity_id)
    .bind(scope.workplace_id)
    .fetch_all(tx.as_mut())
    .await?)
}

fn refusal(key: &str, id: Uuid, code: &'static str, alternatives: &[Uuid]) -> Value {
    let mut r = json!({ key: id, "code": code });
    if code == "workplace_not_open" {
        r["open_workplace_ids"] = json!(alternatives);
    }
    r
}
