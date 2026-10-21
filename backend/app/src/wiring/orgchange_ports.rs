//! Org-change seam implementations over the canonical adapters.

use console_kernel_core::{KernelError, OrgId, UserId};
use console_ontology_canonical_adapter_postgres::org_unit::{
    OrgUnitCommand, OrgUnitError, OrgUnitQuery,
};
use console_orgchange_adapter_postgres::{
    EmploymentTransferPort, OrgUnitWriteFuture, OrgUnitWritePort, PeopleMove, PeopleMoveCause,
    TransferPortFuture,
};

/// The `console-app` half of the org-change → people seam: binds the owners'
/// writes (hr's dated lifecycle event, entity's assignment split; see
/// [`super::orgchange_people`]) to the [`EmploymentTransferPort`] trait the
/// orgchange adapter declares. The orgchange adapter cannot take a Cargo edge
/// on those adapters (adapter→adapter is illegal), so this crate — the
/// composition root, which the layer gate allows to see everything — is where
/// they meet.
pub(crate) struct PgEmploymentTransferPort;

impl EmploymentTransferPort for PgEmploymentTransferPort {
    fn move_people<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        org: OrgId,
        actor: UserId,
        cause: PeopleMoveCause,
        what: PeopleMove,
    ) -> TransferPortFuture<'tx> {
        Box::pin(super::orgchange_people::move_people(
            tx, org, actor, cause, what,
        ))
    }
}

/// The `console-app` half of the org-change → OrgUnit port seam: binds the
/// owner's `org_unit::write_in_tx` (`organization.create_org_unit` /
/// `organization.revise_org_unit`) to the orgchange adapter's
/// [`OrgUnitWritePort`], so `*_ORG_UNIT` ops apply inside the org-change apply
/// transaction with no second writer.
pub(crate) struct PgOrgUnitWritePort;

impl OrgUnitWritePort for PgOrgUnitWritePort {
    fn write<'tx>(
        &self,
        tx: &'tx mut sqlx::Transaction<'_, sqlx::Postgres>,
        org: OrgId,
        actor: UserId,
        command_id: uuid::Uuid,
        org_unit_id: Option<uuid::Uuid>,
        attributes: serde_json::Value,
    ) -> OrgUnitWriteFuture<'tx> {
        Box::pin(async move {
            let (query, action_key) = match org_unit_id {
                None => (
                    OrgUnitQuery::Create {
                        source: None,
                        attributes,
                    },
                    "internal.org_change.create_org_unit",
                ),
                Some(org_unit_id) => (
                    OrgUnitQuery::Revise {
                        org_unit_id,
                        source: None,
                        attributes,
                    },
                    "internal.org_change.revise_org_unit",
                ),
            };
            let command = OrgUnitCommand {
                org_id: org,
                command_id: console_ontology_canonical_domain::CommandId::from_uuid(command_id),
                actor_id: actor,
                query,
                action_key: action_key.to_owned(),
                object_type_id: uuid::Uuid::nil(),
            };
            let receipt = console_ontology_canonical_adapter_postgres::org_unit::write_in_tx(
                tx, &command,
            )
            .await
            .map_err(|error| match error {
                // Apply-time refusals (kind nesting, dissolved parent, cycle)
                // are conflicts with the approved proposal, not server faults.
                OrgUnitError::Blocked(_) | OrgUnitError::DigestConflict(_) => {
                    KernelError::conflict(error.to_string())
                }
                OrgUnitError::Database(_) | OrgUnitError::UnreadableReceipt(_, _) => {
                    tracing::error!(error = %error, "org-unit write failed at the org-change seam");
                    KernelError::internal("org-unit write failed")
                }
            })?;
            receipt.result()["org_unit_id"]
                .as_str()
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .ok_or_else(|| KernelError::internal("org-unit receipt names no unit"))
        })
    }
}
