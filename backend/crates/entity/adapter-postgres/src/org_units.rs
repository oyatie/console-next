//! Setup-phase org units, one at a time: create, rename/move and dissolve a
//! 부서 immediately, without an org-change proposal (the solo-admin
//! IN_APPROVAL dead end), through the canonical OrgUnit owner
//! (`organization.create_org_unit` / `revise_org_unit`). Each call is a
//! batch of one (`org_batch`), so it is pinned, recorded and undoable like
//! any batch.
//!
//! One 부서 kind (decisions #18): a 부서 sits in a 사업장 (under the SITE unit
//! that `represents_workplace`, created with the 사업장, decisions #14.1;
//! a 사업장 from before that change gets it on first use here) or under
//! another 부서, at any depth. The client never creates SITE units (§3.7).

use console_entity_application::{
    Actor, CreateSetupOrgUnit, OrgParent, OrgSetupOp, OrgSetupReceipt, RenameSetupOrgUnit,
};
use console_entity_domain::Refusal;
use console_kernel_core::{KernelError, OrgId, UserId};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::sync::Arc;
use uuid::Uuid;

use crate::org_batch::BatchMode;
use crate::{PgEntityError, PgEntityStore};

/// The future an [`OrgUnitSetupWritePort::write`] returns (borrows the tx).
pub type OrgUnitSetupFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Uuid, KernelError>> + Send + 'a>>;

/// Consumer-declared seam to the canonical OrgUnit owner, injected by the
/// composition root (same shape as orgchange's `OrgUnitWritePort`). `None`
/// creates, `Some(id)` revises with the full attribute bag.
pub trait OrgUnitSetupWritePort: Send + Sync {
    fn write<'tx>(
        &self,
        tx: &'tx mut Transaction<'_, Postgres>,
        org: OrgId,
        actor: UserId,
        command_id: Uuid,
        org_unit_id: Option<Uuid>,
        attributes: Value,
    ) -> OrgUnitSetupFuture<'tx>;

    /// Whether the tenant routes org changes through 결재
    /// (`approval.policy.org_structure` ≠ `none`, decisions #26), read in the
    /// write's transaction. A direct 부서 write after 운영 시작 is refused
    /// then (`org_change_routed`). Fail closed: routed unless the root says not.
    fn org_changes_routed<'tx>(
        &self,
        _tx: &'tx mut Transaction<'_, Postgres>,
        _org: OrgId,
    ) -> RoutedFuture<'tx> {
        Box::pin(async { Ok(true) })
    }
}

/// The future [`OrgUnitSetupWritePort::org_changes_routed`] returns.
pub type RoutedFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, KernelError>> + Send + 'a>>;

pub(crate) fn port_refusal(err: KernelError) -> PgEntityError {
    Refusal::conflict("org_unit_write_refused", err.message).into()
}

impl PgEntityStore {
    /// Create one 부서 in a 사업장 or under a 부서.
    ///
    /// # Errors
    /// `phase_not_setup` (remedy: submit an org change), field issues, or the
    /// canonical owner's refusal.
    pub async fn create_setup_org_unit(
        &self,
        actor: &Actor,
        cmd: CreateSetupOrgUnit,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<OrgSetupReceipt, PgEntityError> {
        if !matches!(cmd.kind.as_deref(), None | Some("DEPARTMENT" | "TEAM")) {
            return Err(Refusal::field("kind", "invalid_choice").into());
        }
        let request = serde_json::to_value(&cmd)?;
        let op = OrgSetupOp::Create {
            client_ref: None,
            name: cmd.name,
            parent: OrgParent {
                workplace_id: cmd.workplace_id,
                parent_org_unit_id: cmd.parent_org_unit_id,
                parent_ref: None,
            },
            code: None,
            head_employee_id: None,
        };
        self.run_batch(
            actor,
            "org_unit.setup_create",
            request,
            vec![op],
            BatchMode::Unit,
            port,
        )
        .await
    }

    /// Rename and/or move one 부서 (a move to another 사업장 takes its people's
    /// 사업장 placement with it).
    ///
    /// # Errors
    /// `phase_not_setup`, field issues, `stale_revision`, `site_is_a_workplace`,
    /// or the canonical owner's refusal.
    pub async fn rename_setup_org_unit(
        &self,
        actor: &Actor,
        id: Uuid,
        cmd: RenameSetupOrgUnit,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<OrgSetupReceipt, PgEntityError> {
        let request = json!({ "id": id, "rename": cmd });
        let moving = cmd.parent != OrgParent::default();
        let mut ops = Vec::new();
        if cmd.name.is_some() || !moving {
            ops.push(OrgSetupOp::Rename {
                org_unit_id: Some(id),
                expected_version: cmd.expected_version,
                name: cmd.name,
            });
        }
        if moving {
            // A rename in the same call has already moved the version on.
            let pin = if ops.is_empty() {
                cmd.expected_version
            } else {
                None
            };
            ops.push(OrgSetupOp::Move {
                org_unit_id: Some(id),
                expected_version: pin,
                parent: cmd.parent,
            });
        }
        self.run_batch(
            actor,
            "org_unit.setup_rename",
            request,
            ops,
            BatchMode::Unit,
            port,
        )
        .await
    }

    /// Dissolve one 부서 and the 부서 under it (refused while people are placed there).
    ///
    /// # Errors
    /// `phase_not_setup`, `stale_revision`, `org_unit_has_members`, `site_is_a_workplace`.
    pub async fn dissolve_setup_org_unit(
        &self,
        actor: &Actor,
        id: Uuid,
        expected_version: Option<i32>,
        port: Arc<dyn OrgUnitSetupWritePort>,
    ) -> Result<OrgSetupReceipt, PgEntityError> {
        let request = json!({ "id": id, "expected_version": expected_version });
        let op = OrgSetupOp::Dissolve {
            org_unit_id: Some(id),
            expected_version,
        };
        self.run_batch(
            actor,
            "org_unit.setup_dissolve",
            request,
            vec![op],
            BatchMode::Unit,
            port,
        )
        .await
    }
}
