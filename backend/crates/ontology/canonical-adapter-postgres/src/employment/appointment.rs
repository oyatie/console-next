// SPDX-License-Identifier: LicenseRef-Proprietary
//! One appointment insert for canonical commands and registration batches.

use std::collections::HashMap;

use super::receipt::{payload_digest, receipt};
use super::{EmploymentCommand, EmploymentError, EmploymentQuery};
use console_ontology_canonical_domain::{CanonicalQuery, CommandReceipt, ReceiptOwner};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

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
    let valid_from: Vec<_> = commands.iter().map(|(_, c)| c.query.valid_from()).collect();
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
