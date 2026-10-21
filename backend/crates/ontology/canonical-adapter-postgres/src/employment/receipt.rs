//! The command receipt: build, read back, and the payload digest it is keyed on.

use super::error::EmploymentError;
use super::model::{EmploymentCommand, EmploymentQuery};
use console_kernel_core::UserId;
use console_ontology_canonical_domain::{CommandReceipt, DispatchTarget, ObjectKey, ReceiptOwner};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use time::OffsetDateTime;
use uuid::Uuid;

pub(super) fn receipt(
    command: &EmploymentCommand,
    target: DispatchTarget,
    actor_id: UserId,
    digest: [u8; 32],
    result: serde_json::Value,
    created_at: OffsetDateTime,
) -> CommandReceipt {
    CommandReceipt::new(
        command.org_id,
        command.command_id,
        ReceiptOwner::Canonical(ObjectKey::Employment),
        target,
        actor_id,
        digest,
        result,
        created_at,
    )
}

/// The target a stored receipt names, read back through the roster's `FromStr`
/// rather than re-spelled here.
pub(super) fn stored_target(
    command_id: Uuid,
    result: &serde_json::Value,
) -> Result<DispatchTarget, EmploymentError> {
    let stored = result["target"]
        .as_str()
        .ok_or_else(|| EmploymentError::UnreadableReceipt(command_id, result.to_string()))?;
    DispatchTarget::from_str(stored)
        .map_err(|error| EmploymentError::UnreadableReceipt(command_id, error.to_string()))
}

/// The 32 bytes the `payload_digest` CHECK is sized for.
///
/// Every field is hashed in a fixed order from TYPED values, never from a
/// `serde_json::Value`: `serde_json` resolves with `preserve_order` in this
/// workspace, so a `Value` serialises its object keys in INSERTION order and two
/// payloads that compare EQUAL serialise to different bytes. The retry a client
/// performs after a timeout must digest to the same 32 bytes, or it comes back
/// as a [`EmploymentError::DigestConflict`] instead of the documented replay.
/// `None` and `Some("")` are separated by a tag byte, so an absent org unit and
/// a blank one are not the same command.
pub(super) fn payload_digest(command: &EmploymentCommand) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(command.org_id.as_uuid().as_bytes());
    hasher.update(command.command_id.as_uuid().as_bytes());
    hasher.update(command.actor_id.as_uuid().as_bytes());
    hasher.update(command.query.target().as_str().as_bytes());
    match &command.query {
        EmploymentQuery::Appoint { employee_id, .. } => hasher.update(employee_id.as_bytes()),
        EmploymentQuery::Promote { employment_id, .. }
        | EmploymentQuery::Transfer { employment_id, .. } => {
            hasher.update(employment_id.as_bytes());
        }
    }
    hasher.update(
        command
            .query
            .valid_from()
            .unix_timestamp_nanos()
            .to_be_bytes(),
    );
    let attributes = command.query.attributes();
    // Tag + 16 raw bytes for UUID options; tag-only for None. Length-prefixed
    // UTF-8 would let a free-text label collide with a UUID string encoding.
    hasher.update(attributes.company.as_bytes());
    match attributes.org_unit_id {
        Some(id) => {
            hasher.update([1_u8]);
            hasher.update(id.as_bytes());
        }
        None => hasher.update([0_u8]),
    }
    match attributes.job_position_id {
        Some(id) => {
            hasher.update([1_u8]);
            hasher.update(id.as_bytes());
        }
        None => hasher.update([0_u8]),
    }
    hasher.update(attributes.employment_status.as_bytes());
    hasher.finalize().into()
}
