// SPDX-License-Identifier: LicenseRef-Proprietary
//! Registration appointments share reference checks, frozen-window locks and one write.
use std::collections::BTreeSet;

use super::{EmploymentError, receipt::payload_digest, write::write_in_tx};
use super::{change_window, derived::legacy_head_command, lookups::ensure_attribute_refs};
use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_domain::{CanonicalPort, CanonicalQuery, ReceiptOwner};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

/// Appoint unbound legacy heads with the single writer's commands and validation.
/// Callers own authorization and must roll back the transaction on any error.
pub async fn appoint_legacy_heads_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employees: &[Uuid],
) -> Result<(), EmploymentError> {
    let rows = sqlx::query(
        "SELECT e.id,e.company,e.org_unit,e.org_unit_id,e.position,e.employment_status,e.hire_on, \
         EXISTS(SELECT 1 FROM employment_source_bindings b WHERE b.org_id=e.org_id AND b.employee_id=e.id) AS bound \
         FROM employees e WHERE e.org_id=$1 AND e.id=ANY($2) ORDER BY e.id",
    ).bind(org.as_uuid()).bind(employees).fetch_all(tx.as_mut()).await?;
    let mut commands = Vec::with_capacity(rows.len());
    for row in rows {
        if let Some(command) = legacy_head_command(org, actor, row.try_get("id")?, &row)? {
            commands.push(command);
        }
    }
    let Some(first) = commands.first() else {
        return Ok(());
    };
    let replay: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM ont_action_command_receipts WHERE org_id=$1 AND command_id=ANY($2))",
    ).bind(org.as_uuid())
        .bind(commands.iter().map(|c|*c.command_id.as_uuid()).collect::<Vec<_>>())
        .fetch_one(tx.as_mut()).await?;
    // Exceptional stored receipts retain the single writer's digest and receipt validation.
    if replay {
        for command in &commands {
            write_in_tx(tx, command).await?;
        }
        return Ok(());
    }
    let mut refs = BTreeSet::new();
    let mut dates = BTreeSet::new();
    let mut input = Vec::with_capacity(commands.len());
    for command in &commands {
        let preflight = <super::PgEmploymentPort as CanonicalPort>::preflight(&command.query);
        if !preflight.is_ok() {
            return Err(EmploymentError::Blocked(preflight.blockers().to_vec()));
        }
        let attrs = command.query.attributes();
        if refs.insert((attrs.org_unit_id, attrs.job_position_id)) {
            ensure_attribute_refs(tx, *org.as_uuid(), attrs).await?;
        }
        let date = change_window::business_date(command.query.valid_from());
        if dates.insert(date) {
            change_window::assert_employment_change_window_open(tx, *org.as_uuid(), date).await?;
        }
        let super::EmploymentQuery::Appoint { employee_id, .. } = command.query else {
            unreachable!("legacy heads derive appointments");
        };
        input.push(
            json!({"employee": employee_id,"command":command.command_id.as_uuid(),
            "on_at":command.query.valid_from().to_string(),"attributes":attrs.to_json(),
            "digest":hex::encode(payload_digest(command))}),
        );
    }
    sqlx::query(
        "WITH input AS MATERIALIZED (SELECT r.*,gen_random_uuid() AS employment_id \
           FROM jsonb_to_recordset($3) r(employee uuid,command uuid,on_at timestamptz,attributes jsonb,digest text)), \
         heads AS (INSERT INTO employment_heads (org_id,id,valid_from) \
           SELECT $1,employment_id,on_at FROM input RETURNING id), \
         revisions AS (INSERT INTO employment_revisions \
           (org_id,employment_id,version,command_id,actor_id,payload_digest,valid_from,attributes,receipt) \
           SELECT $1,i.employment_id,1,i.command,$2,decode(i.digest,'hex'),i.on_at,i.attributes, \
             jsonb_build_object('employment_id',i.employment_id::text,'version',1,'target',$4::text) \
           FROM input i JOIN heads h ON h.id=i.employment_id RETURNING employment_id,receipt,created_at), \
         bindings AS (INSERT INTO employment_source_bindings (org_id,employee_id,employment_id,actor_id,payload_digest) \
           SELECT $1,i.employee,i.employment_id,$2,decode(i.digest,'hex') FROM input i JOIN revisions r USING(employment_id) \
           RETURNING employment_id) \
         INSERT INTO ont_action_command_receipts \
           (org_id,command_id,actor_id,payload_digest,receipt,action_key,object_type_id,created_at,owner,target) \
         SELECT $1,i.command,$2,decode(i.digest,'hex'),r.receipt,$5,$6,r.created_at,$7,$8 \
         FROM input i JOIN revisions r USING(employment_id) JOIN bindings b USING(employment_id)",
    ).bind(org.as_uuid()).bind(actor.as_uuid()).bind(json!(input))
        .bind(first.query.target().as_str()).bind(&first.action_key).bind(first.object_type_id)
        .bind(ReceiptOwner::Canonical(first.query.dispatch_target().object()).as_str())
        .bind(first.query.dispatch_target().as_str()).execute(tx.as_mut()).await?;
    Ok(())
}
