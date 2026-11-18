// SPDX-License-Identifier: LicenseRef-Proprietary
//! Shared canonical hire inserts and lifecycle appointment head updates.

use std::collections::HashMap;

use super::receipt::{payload_digest, receipt};
use super::{EmploymentCommand, EmploymentError, EmploymentQuery};
use console_ontology_canonical_domain::{CanonicalQuery, CommandReceipt, ReceiptOwner};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// The validated head left by a lifecycle APPOINT, shared by single and bulk writes.
pub struct AppointmentHead<'a> {
    pub valid_from: OffsetDateTime,
    pub company: &'a str,
    pub org_unit: Option<&'a str>,
    pub position: Option<&'a str>,
    pub rebind: Option<Option<Uuid>>,
    pub employment_status: &'a str,
    pub classification: [Option<Uuid>; 4],
    pub job: Option<&'a str>,
}

/// Apply validated appointments to existing heads; callers own authorization and rollback.
pub async fn apply_appointment_heads_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    heads: &[(Uuid, AppointmentHead<'_>)],
) -> Result<(), EmploymentError> {
    if heads.is_empty() {
        return Ok(());
    }
    let mut checks = super::checks::WriteChecks::default();
    for (_, head) in heads {
        checks.check_date(tx, org, head.valid_from).await?;
    }
    let attributes: Vec<_> = heads.iter().map(|(_, head)| {
        let [grade, position_kind, job_id, job_family] = head.classification;
        serde_json::json!({"company":head.company,"unit":head.org_unit,"position":head.position,
            "status":head.employment_status,"rebind":head.rebind.is_some(),"unit_id":head.rebind.flatten(),"grade":grade,"position_kind":position_kind,
            "job_id":job_id,"job_family":job_family,"job":head.job})
    }).collect();
    sqlx::query(
        "UPDATE employees e SET company=r.attrs->>'company',org_unit=r.attrs->>'unit', \
         org_unit_id=CASE WHEN (r.attrs->>'rebind')::boolean THEN (r.attrs->>'unit_id')::uuid ELSE e.org_unit_id END, \
         position=COALESCE(r.attrs->>'position',e.position),employment_status=r.attrs->>'status', \
         exit_on=CASE WHEN r.attrs->>'status'='EXITED' THEN r.on_date END, \
         exit_date=CASE WHEN r.attrs->>'status'='EXITED' THEN to_char(r.on_date,'YYYY-MM-DD') END, \
         grade_id=(r.attrs->>'grade')::uuid,position_kind_id=(r.attrs->>'position_kind')::uuid, \
         job_id=(r.attrs->>'job_id')::uuid,job_family_id=(r.attrs->>'job_family')::uuid,job=r.attrs->>'job', \
         head_version=e.head_version+1,updated_at=now() \
         FROM unnest($2::uuid[],$3::date[],$4::jsonb[]) r(id,on_date,attrs) \
         WHERE e.org_id=$1 AND e.id=r.id",
    ).bind(org).bind(heads.iter().map(|(id, _)| *id).collect::<Vec<_>>())
        .bind(heads.iter().map(|(_, head)| super::change_window::business_date(head.valid_from)).collect::<Vec<_>>())
        .bind(attributes).execute(tx.as_mut()).await?;
    Ok(())
}

/// Callers have checked preflight, references, replay and the locked change window.
/// Commands share the tenant, actor and action metadata of a registration batch.
pub(super) async fn insert_appointments(
    tx: &mut Transaction<'_, Postgres>,
    commands: &[(Uuid, &EmploymentCommand)],
) -> Result<Vec<CommandReceipt>, EmploymentError> {
    let Some((_, first)) = commands.first() else {
        return Ok(Vec::new());
    };
    debug_assert!(commands.iter().all(|(employee_id, command)| {
        matches!(&command.query, EmploymentQuery::Appoint { employee_id: id, .. } if id == employee_id)
            && command.org_id == first.org_id
            && command.actor_id == first.actor_id
            && command.action_key == first.action_key
            && command.object_type_id == first.object_type_id
            && command.query.target() == first.query.target()
    }));
    let employees: Vec<_> = commands.iter().map(|(id, _)| *id).collect();
    let command_ids: Vec<_> = commands
        .iter()
        .map(|(_, c)| *c.command_id.as_uuid())
        .collect();
    let valid_from: Vec<_> = commands
        .iter()
        .map(|(_, c)| super::change_window::postgres_instant(c.query.valid_from()))
        .collect();
    let attributes: Vec<_> = commands
        .iter()
        .map(|(_, c)| c.query.attributes().to_json())
        .collect();
    let digests: Vec<_> = commands
        .iter()
        .map(|(_, c)| hex::encode(payload_digest(c)))
        .collect();
    let rows: Vec<(Uuid, serde_json::Value, OffsetDateTime)> = sqlx::query_as(
        "WITH input AS MATERIALIZED (SELECT r.*,gen_random_uuid() AS employment_id \
           FROM unnest($3::uuid[],$4::uuid[],$5::timestamptz[],$6::jsonb[],$7::text[]) \
             r(employee,command,on_at,attributes,digest)), \
         heads AS (INSERT INTO employment_heads (org_id,id,valid_from) \
           SELECT $1,employment_id,on_at FROM input RETURNING id), \
         revisions AS (INSERT INTO employment_revisions \
           (org_id,employment_id,version,command_id,actor_id,payload_digest,valid_from,attributes,receipt) \
           SELECT $1,i.employment_id,1,i.command,$2,decode(i.digest,'hex'),i.on_at,i.attributes, \
             jsonb_build_object('employment_id',i.employment_id::text,'version',1,'target',$8::text) \
           FROM input i JOIN heads h ON h.id=i.employment_id RETURNING employment_id,receipt,created_at), \
         bindings AS (INSERT INTO employment_source_bindings (org_id,employee_id,employment_id,actor_id,payload_digest) \
           SELECT $1,i.employee,i.employment_id,$2,decode(i.digest,'hex') FROM input i JOIN revisions r USING(employment_id) \
           RETURNING employment_id) \
         INSERT INTO ont_action_command_receipts \
           (org_id,command_id,actor_id,payload_digest,receipt,action_key,object_type_id,created_at,owner,target) \
         SELECT $1,i.command,$2,decode(i.digest,'hex'),r.receipt,$9,$10,r.created_at,$11,$12 \
         FROM input i JOIN revisions r USING(employment_id) JOIN bindings b USING(employment_id) RETURNING command_id,receipt,created_at",
    ).bind(first.org_id.as_uuid()).bind(first.actor_id.as_uuid()).bind(&employees).bind(&command_ids).bind(&valid_from).bind(&attributes).bind(&digests)
        .bind(first.query.target().as_str()).bind(&first.action_key).bind(first.object_type_id)
        .bind(ReceiptOwner::Canonical(first.query.dispatch_target().object()).as_str())
        .bind(first.query.dispatch_target().as_str()).fetch_all(tx.as_mut()).await?;
    let mut rows: HashMap<_, _> = rows
        .into_iter()
        .map(|(id, result, created_at)| (id, (result, created_at)))
        .collect();
    commands
        .iter()
        .map(|(_, command)| {
            let (result, created_at) = rows
                .remove(command.command_id.as_uuid())
                .ok_or(sqlx::Error::RowNotFound)?;
            Ok(receipt(
                command,
                command.query.target(),
                command.actor_id,
                payload_digest(command),
                result,
                created_at,
            ))
        })
        .collect()
}
