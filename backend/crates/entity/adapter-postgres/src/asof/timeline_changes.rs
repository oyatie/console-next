//! Scope references and exact node attribution are separate boundaries.
use crate::{PgEntityError, Tx};
use console_entity_application::{ReadOptions, ScheduledBy};
use console_orgchange_domain::{OrgProposalOp, projection::projected_unit_id};
use sqlx::Row;
use std::collections::{HashMap, HashSet};
use time::Date;
use uuid::Uuid;

pub(super) struct Change {
    pub meta: ScheduledBy,
    pub references: HashSet<Uuid>,
    pub affected: HashSet<Uuid>,
}

fn references(v: &serde_json::Value, out: &mut HashSet<Uuid>) {
    match v {
        serde_json::Value::String(s) => {
            if let Ok(id) = Uuid::parse_str(s) {
                out.insert(id);
            }
        }
        serde_json::Value::Array(vs) => {
            for v in vs {
                references(v, out);
            }
        }
        serde_json::Value::Object(vs) => {
            for v in vs.values() {
                references(v, out);
            }
        }
        _ => {}
    }
}
pub(super) async fn changes(
    tx: &mut Tx<'_>,
    a: Date,
    b: Date,
    q: ReadOptions,
) -> Result<Vec<Change>, PgEntityError> {
    let rows = sqlx::query(
        "SELECT r.id, r.code, (h.v->>'effective_date')::date AS effective_date, h.v->'proposal' AS proposal \
         FROM org_change_requests r JOIN LATERAL (SELECT v FROM jsonb_array_elements(r.projection_history) \
             WITH ORDINALITY AS history(v,n) WHERE (v->>'recorded_at')::timestamptz <= COALESCE($3::timestamptz,now()) \
             ORDER BY n DESC LIMIT 1) h ON true \
         WHERE (h.v->>'effective_date')::date > $1 AND (h.v->>'effective_date')::date <= $2 \
           AND h.v->>'status' IN ('APPLIED','ARCHIVED','SETTLING','APPROVED','IN_APPROVAL') ORDER BY effective_date,r.code",
    ).bind(a).bind(b).bind(q.known_at).fetch_all(tx.as_mut()).await?;
    let commands: Vec<Uuid> = rows
        .iter()
        .flat_map(|r| {
            let id: Uuid = r.get("id");
            let proposal: serde_json::Value = r.get("proposal");
            (0..proposal.as_array().map_or(0, Vec::len))
                .map(move |index| projected_unit_id(id, index))
        })
        .collect();
    let canonical: HashMap<Uuid, Uuid> = sqlx::query_as::<_, (Uuid, Uuid)>(
        "SELECT command_id,org_unit_id FROM org_unit_revisions WHERE command_id = ANY($1) \
         AND created_at <= COALESCE($2::timestamptz,now())",
    )
    .bind(commands)
    .bind(q.known_at)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .collect();
    rows.into_iter()
        .map(|r| {
            let mut ids = HashSet::new();
            let proposal = r.try_get::<serde_json::Value, _>("proposal")?;
            references(&proposal, &mut ids);
            let mut affected = HashSet::new();
            let ops: Vec<OrgProposalOp> = serde_json::from_value(proposal).map_err(|e| {
                PgEntityError::from(console_kernel_core::KernelError::internal(e.to_string()))
            })?;
            for (index, op) in ops.iter().enumerate() {
                match op {
                    OrgProposalOp::CreateOrgUnit { .. } => {
                        let command = projected_unit_id(r.try_get("id")?, index);
                        ids.insert(command);
                        affected.insert(command);
                        if let Some(id) = canonical.get(&command) {
                            ids.insert(*id);
                            affected.insert(*id);
                        }
                    }
                    OrgProposalOp::RenameOrgUnit { org_unit_id, .. }
                    | OrgProposalOp::MoveOrgUnit { org_unit_id, .. }
                    | OrgProposalOp::DissolveOrgUnit { org_unit_id, .. } => {
                        affected.insert(*org_unit_id);
                    }
                    OrgProposalOp::ReassignOrgUnit {
                        from_org_unit,
                        to_org_unit,
                        ..
                    } => {
                        for id in [from_org_unit, to_org_unit] {
                            if let Ok(id) = Uuid::parse_str(id) {
                                affected.insert(id);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Change {
                meta: ScheduledBy {
                    change_id: r.try_get("id")?,
                    code: r.try_get("code")?,
                    effective_date: r.try_get::<Date, _>("effective_date")?.to_string(),
                },
                references: ids,
                affected,
            })
        })
        .collect()
}
