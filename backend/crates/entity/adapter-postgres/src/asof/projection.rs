//! Approved org-change replay for the composed chart, never a write or an employee API.
use super::membership::Membership;
use crate::{
    PgEntityError, Tx,
    asof::tree::{Tree, Unit},
};
use console_entity_application::{ReadPoint, ScheduledBy};
use console_orgchange_domain::{
    OrgProposalOp,
    projection::{ProjectedChange, project_units},
};
use serde_json::json;
use sqlx::Row;
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

pub(super) type Changes = Vec<(ProjectedChange, Vec<OrgProposalOp>)>;

pub(super) async fn load(tx: &mut Tx<'_>, point: ReadPoint) -> Result<Changes, PgEntityError> {
    let rows = sqlx::query(
        "SELECT r.id, r.code, (h.v->>'effective_date')::date AS effective_date, h.v->'proposal' AS proposal \
         FROM org_change_requests r JOIN LATERAL (SELECT v FROM jsonb_array_elements(r.projection_history) \
             WITH ORDINALITY AS history(v,n) WHERE (v->>'recorded_at')::timestamptz <= COALESCE($2::timestamptz,now()) \
             ORDER BY n DESC LIMIT 1) h ON true \
         WHERE (h.v->>'effective_date')::date <= $1 \
           AND h.v->>'status' IN ('APPROVED','IN_APPROVAL') ORDER BY effective_date, r.code",
    ).bind(point.as_of).bind(point.known_at).fetch_all(tx.as_mut()).await?;
    let mut changes = Vec::new();
    for r in rows {
        let proposal: serde_json::Value = r.try_get("proposal")?;
        let ops: Vec<OrgProposalOp> = serde_json::from_value(proposal).map_err(|e| {
            console_entity_domain::Refusal::new(
                console_kernel_core::ErrorKind::Internal,
                "internal",
                e.to_string(),
            )
        })?;
        changes.push((
            ProjectedChange {
                id: r.try_get("id")?,
                code: r.try_get("code")?,
                effective_date: r.try_get("effective_date")?,
            },
            ops,
        ));
    }
    Ok(changes)
}

pub(crate) async fn apply(
    tx: &mut Tx<'_>,
    point: ReadPoint,
    tree: &mut Tree,
    members: &mut [Membership],
) -> Result<HashMap<Uuid, ScheduledBy>, PgEntityError> {
    let changes = load(tx, point).await?;
    let mut attrs: BTreeMap<_, _> = tree
        .units
        .iter()
        .map(|(id, u)| {
            (
                *id,
                json!({"name":u.name,"kind":u.kind,"parent_id":u.parent,"status":"active"}),
            )
        })
        .collect();
    let (marks, moves) = project_units(&mut attrs, &changes);
    for (id, a) in attrs {
        if a["status"] == "dissolved" {
            tree.units.remove(&id);
            continue;
        }
        let u = tree.units.entry(id).or_insert(Unit {
            name: String::new(),
            kind: String::new(),
            parent: None,
            version: 0,
            position: None,
            code: None,
            head: None,
            direct: 0,
            dispatched: 0,
        });
        u.name = a["name"].as_str().unwrap_or_default().into();
        u.kind = a["kind"].as_str().unwrap_or_default().into();
        u.parent = a["parent_id"]
            .as_str()
            .and_then(|v| Uuid::parse_str(v).ok());
    }
    // Native reassignment moves source-unit members across companies, keeping each company.
    for movement in moves {
        for m in members.iter_mut() {
            if m.unit == Some(movement.from)
                && movement
                    .employees
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&m.employee))
            {
                m.unit = Some(movement.to);
                m.projected = true;
            }
        }
    }
    let moved: std::collections::HashSet<_> = changes
        .iter()
        .flat_map(|(_, ops)| ops)
        .filter_map(|op| {
            if let OrgProposalOp::MoveOrgUnit { org_unit_id, .. } = op {
                Some(*org_unit_id)
            } else {
                None
            }
        })
        .collect();
    for m in members.iter_mut() {
        let mut cursor = m.unit;
        let mut seen = std::collections::HashSet::new();
        while let Some(id) = cursor.filter(|id| seen.insert(*id)) {
            if moved.contains(&id) {
                m.projected = true;
                break;
            }
            cursor = tree.units.get(&id).and_then(|u| u.parent);
        }
    }
    tree.children.clear();
    for (id, u) in &tree.units {
        if let Some(p) = u.parent.filter(|p| tree.units.contains_key(p)) {
            tree.children.entry(p).or_default().push(*id);
        }
    }
    for ids in tree.children.values_mut() {
        ids.sort_by_key(|id| {
            let u = &tree.units[id];
            (u.position.is_none(), u.position, u.name.clone(), *id)
        });
    }
    Ok(marks
        .into_iter()
        .map(|(id, c)| {
            (
                id,
                ScheduledBy {
                    change_id: c.id,
                    code: c.code,
                    effective_date: c.effective_date.to_string(),
                },
            )
        })
        .collect())
}
