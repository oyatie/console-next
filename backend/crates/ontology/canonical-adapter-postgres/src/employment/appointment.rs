//! The appointment's head, first revision, source binding and replay receipt in one round trip.

use super::error::EmploymentError;
use super::model::EmploymentCommand;
use super::receipt::receipt;
use console_ontology_canonical_domain::{CanonicalQuery, CommandReceipt, ReceiptOwner};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// The caller has already checked preflight, references, replay and the locked change window.
pub(super) async fn appoint_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    command: &EmploymentCommand,
    employee: Uuid,
    digest: [u8; 32],
) -> Result<CommandReceipt, EmploymentError> {
    let target = command.query.target();
    let dispatch = command.query.dispatch_target();
    let owner = ReceiptOwner::Canonical(dispatch.object());
    let (result, created_at): (serde_json::Value, OffsetDateTime) = sqlx::query_as(
        "WITH head AS ( \
           INSERT INTO employment_heads (org_id, valid_from) VALUES ($1, $2) RETURNING id \
         ), revision AS ( \
           INSERT INTO employment_revisions \
             (org_id, employment_id, version, command_id, actor_id, payload_digest, \
              valid_from, attributes, receipt) \
           SELECT $1, id, 1, $3, $4, $5, $2, $6, \
             jsonb_build_object('employment_id', id::TEXT, 'version', 1, 'target', $7::TEXT) \
           FROM head RETURNING employment_id, receipt, created_at \
         ), binding AS ( \
           INSERT INTO employment_source_bindings \
             (org_id, employee_id, employment_id, actor_id, payload_digest) \
           SELECT $1, $8, employment_id, $4, $5 FROM revision RETURNING employment_id \
         ) \
         INSERT INTO ont_action_command_receipts \
           (org_id, command_id, actor_id, payload_digest, receipt, action_key, object_type_id, \
            created_at, owner, target) \
         SELECT $1, $3, $4, $5, r.receipt, $9, $10, r.created_at, $11, $12 \
         FROM revision r JOIN binding b USING (employment_id) RETURNING receipt, created_at",
    )
    .bind(command.org_id.as_uuid())
    .bind(command.query.valid_from())
    .bind(command.command_id.as_uuid())
    .bind(command.actor_id.as_uuid())
    .bind(digest.as_slice())
    .bind(command.query.attributes().to_json())
    .bind(target.as_str())
    .bind(employee)
    .bind(&command.action_key)
    .bind(command.object_type_id)
    .bind(owner.as_str())
    .bind(dispatch.as_str())
    .fetch_one(tx.as_mut())
    .await?;
    Ok(receipt(
        command,
        target,
        command.actor_id,
        digest,
        result,
        created_at,
    ))
}
