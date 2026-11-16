// SPDX-License-Identifier: LicenseRef-Proprietary
//! The create writer shares one statement across heads, revisions, bindings and receipts.
use super::*;
use sqlx::QueryBuilder;
use std::collections::BTreeMap;

/// Create Persons in a caller-owned, org-armed transaction, preserving input order.
/// Replays retain the stored actor, digest, result and timestamp. Callers own
/// authorization and auditing, exactly as for [`write_in_tx`], and must roll
/// back the transaction on error.
pub async fn create_many_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    commands: &[PersonCommand],
) -> Result<Vec<CommandReceipt>, PersonError> {
    let mut unique = BTreeMap::new();
    for command in commands {
        let preflight = <PgPersonPort as CanonicalPort>::preflight(&command.query);
        if !preflight.is_ok() {
            return Err(PersonError::Blocked(preflight.blockers().to_vec()));
        }
        if !matches!(command.query, PersonQuery::Create { .. }) {
            return Err(PersonError::Blocked(vec![
                "batch requires Person creates".into(),
            ]));
        }
        let key = (*command.org_id.as_uuid(), *command.command_id.as_uuid());
        let digest = payload_digest(command);
        if let Some((_, previous)) = unique.get(&key)
            && *previous != digest
        {
            return Err(PersonError::DigestConflict(key.1));
        }
        unique.entry(key).or_insert((command, digest));
    }
    let unique: Vec<_> = unique.into_values().collect();
    let mut receipts = BTreeMap::new();
    // Ten parameters per input row, plus the canonical receipt owner.
    const ROWS_PER_INSERT: usize = (u16::MAX as usize - 1) / 10;
    for chunk in unique.chunks(ROWS_PER_INSERT) {
        let mut query = QueryBuilder::<Postgres>::new(
            "WITH input (org_id,command_id,actor_id,payload_digest,person_id,employee_id,attributes,action_key,object_type_id,target) AS (",
        );
        query.push_values(chunk, |mut row, (command, digest)| {
            row.push_bind(command.org_id.as_uuid())
                .push_bind(command.command_id.as_uuid())
                .push_bind(command.actor_id.as_uuid())
                .push_bind(digest.as_slice())
                .push_bind(command.query.employee_id().unwrap_or_else(Uuid::new_v4))
                .push_bind(command.query.employee_id())
                .push_bind(command.query.attributes())
                .push_bind(&command.action_key)
                .push_bind(command.object_type_id)
                .push_bind(command.query.target().as_str());
        });
        query.push(
            "), stored AS MATERIALIZED (
                SELECT r.* FROM ont_action_command_receipts r JOIN input i
                  ON r.org_id=i.org_id AND r.command_id=i.command_id
            ), fresh AS MATERIALIZED (
                SELECT i.*,jsonb_build_object('person_id',i.person_id::text,'version',1,'target',i.target) AS receipt
                FROM input i WHERE NOT EXISTS (
                    SELECT 1 FROM stored s WHERE s.org_id=i.org_id AND s.command_id=i.command_id
                )
            ), heads AS (
                INSERT INTO persons (org_id,id) SELECT org_id,person_id FROM fresh RETURNING org_id,id
            ), revisions AS (
                INSERT INTO person_revisions
                    (org_id,person_id,version,command_id,actor_id,payload_digest,attributes,receipt)
                SELECT f.org_id,f.person_id,1,f.command_id,f.actor_id,f.payload_digest,f.attributes,f.receipt
                FROM fresh f JOIN heads h ON h.org_id=f.org_id AND h.id=f.person_id
                RETURNING org_id,person_id,command_id,actor_id,payload_digest,receipt,created_at
            ), bindings AS (
                INSERT INTO employee_person_bindings (org_id,employee_id,person_id,actor_id,payload_digest)
                SELECT f.org_id,f.employee_id,f.person_id,f.actor_id,f.payload_digest
                FROM fresh f JOIN revisions r ON r.org_id=f.org_id AND r.command_id=f.command_id
                WHERE f.employee_id IS NOT NULL RETURNING org_id,employee_id
            ), written AS (
                INSERT INTO ont_action_command_receipts
                    (org_id,command_id,actor_id,payload_digest,receipt,action_key,object_type_id,created_at,owner,target)
                SELECT r.org_id,r.command_id,r.actor_id,r.payload_digest,r.receipt,f.action_key,f.object_type_id,r.created_at,",
        );
        query.push_bind(ReceiptOwner::Canonical(ObjectKey::Person).as_str());
        query.push(
            ",f.target FROM revisions r JOIN fresh f ON f.org_id=r.org_id AND f.command_id=r.command_id
                LEFT JOIN bindings b ON b.org_id=f.org_id AND b.employee_id=f.employee_id
                RETURNING org_id,command_id,actor_id,payload_digest,receipt,created_at
            ) SELECT org_id,command_id,actor_id,payload_digest,receipt,created_at FROM written
              UNION ALL SELECT org_id,command_id,actor_id,payload_digest,receipt,created_at FROM stored",
        );
        for row in query.build().fetch_all(tx.as_mut()).await? {
            let org: Uuid = row.try_get("org_id")?;
            let id: Uuid = row.try_get("command_id")?;
            receipts.insert((org, id), row);
        }
    }
    commands
        .iter()
        .map(|command| {
            let id = *command.command_id.as_uuid();
            let row = receipts
                .get(&(*command.org_id.as_uuid(), id))
                .ok_or(sqlx::Error::RowNotFound)?;
            let digest = payload_digest(command);
            if row.try_get::<Vec<u8>, _>("payload_digest")? != digest {
                return Err(PersonError::DigestConflict(id));
            }
            let result = row.try_get("receipt")?;
            Ok(receipt(
                command,
                stored_target(id, &result)?,
                UserId::from_uuid(row.try_get("actor_id")?),
                digest,
                result,
                row.try_get("created_at")?,
            ))
        })
        .collect()
}
