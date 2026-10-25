use crate::*;

/// Why people move: the org change that moves them and its 시행일. Every
/// event the move records carries the change's id as its batch, so a person's
/// 인사 이력 links back to the change.
#[derive(Debug, Clone)]
pub struct PeopleMoveCause {
    pub request_id: Uuid,
    pub on: Date,
    /// The person-facing note: the change's code and reason.
    pub note: String,
}

/// Who moves, and where.
#[derive(Debug, Clone)]
pub enum PeopleMove {
    /// `REASSIGN_ORG_UNIT`: the members of `from` (every one, or only
    /// `people`) go to `to` — a 전보, and a 전근 too when `to` sits at another
    /// 사업장.
    Reassign {
        from: Uuid,
        to: Uuid,
        people: Option<Vec<Uuid>>,
    },
    /// `MOVE_ORG_UNIT`: the members of `units` (the moved unit and its
    /// subtree, already re-parented in this transaction) stay in their unit
    /// and follow its 사업장 — a 전근 for each whose 사업장 changes.
    Follow { units: Vec<Uuid> },
}

/// What a move did: how many people it moved, and their audit rows.
#[derive(Debug, Default)]
pub struct PeopleMoved {
    pub people: i64,
    /// Actual changed employees, returned by the port that owns their writes.
    pub employee_ids: Vec<Uuid>,
    pub audits: Vec<AuditEvent>,
}

/// The future an [`EmploymentTransferPort::move_people`] call returns. It
/// borrows the caller's apply transaction for its whole duration — the same
/// lifetime the `with_audits` closure family already pins in
/// `console-platform-db`.
pub type TransferPortFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<PeopleMoved, KernelError>> + Send + 'a>,
>;

/// The people-move seam, declared by the CONSUMER because the layer-boundary
/// gate forbids one adapter depending on another. The composition root
/// (`console-app`) implements it over the owners' own writes — hr's lifecycle
/// record (the dated 전보/전근 event) and entity's assignment split — so this
/// crate keeps the org-change apply transaction and compiles no Employment DML.
/// The 사업장 a unit sits at is the ONE resolver's (the unit's nearest placed
/// ancestor, `employment_hire::unit_placement`).
pub trait EmploymentTransferPort: Send + Sync {
    /// Move `what` inside the caller's org-armed apply transaction. A person
    /// the move does not change (already at that 사업장 and unit) is skipped.
    /// A refusal (a 법인 crossed, a closed period, a later scheduled event the
    /// move would break) keeps its kind and code, and the whole change rolls
    /// back.
    fn move_people<'tx>(
        &self,
        tx: &'tx mut Transaction<'_, Postgres>,
        org: OrgId,
        actor: UserId,
        cause: PeopleMoveCause,
        what: PeopleMove,
    ) -> TransferPortFuture<'tx>;
}

/// The future an [`OrgUnitWritePort::write`] call returns; borrows the apply
/// transaction for its whole duration, like [`TransferPortFuture`].
pub type OrgUnitWriteFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<Uuid, KernelError>> + Send + 'a>>;

/// The OrgUnit-port write seam for the `*_ORG_UNIT` proposal ops, declared by
/// the CONSUMER for the same reason as [`EmploymentTransferPort`]: the owner
/// (`console-ontology-canonical-adapter-postgres`, `ObjectKey::OrgUnit`) holds
/// the DML, and the composition root injects its `org_unit::write_in_tx`.
/// This crate compiles no `org_units` / `org_unit_revisions` DML for these ops.
pub trait OrgUnitWritePort: Send + Sync {
    /// `organization.create_org_unit` when `org_unit_id` is `None`, else
    /// `organization.revise_org_unit` of that unit, with the FULL attribute bag
    /// of the new revision. Returns the unit id. A port refusal (kind nesting,
    /// dissolved parent, cycle) is `Conflict`; anything else `Internal`.
    fn write<'tx>(
        &self,
        tx: &'tx mut Transaction<'_, Postgres>,
        org: OrgId,
        actor: UserId,
        command_id: Uuid,
        org_unit_id: Option<Uuid>,
        attributes: Value,
    ) -> OrgUnitWriteFuture<'tx>;
}
