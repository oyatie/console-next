//! Tenant-armed persistence for the org-change lifecycle engine
//! (draft → preflight → ordered SoD approval → effective-dated apply).
//!
//! Every mutation runs inside one `with_audits` transaction: the request row is
//! locked `FOR UPDATE`, the FSM transition is validated by the domain crate,
//! the append-only `org_change_events` row and the audit-chain rows commit
//! together, and any failure rolls the whole business action back.
//!
//! Apply-time note (scout gap): the identity/registry application commands each
//! open their OWN audited transaction, so replaying an approved proposal
//! through them could commit a partial apply. The executor therefore performs
//! the op SQL itself inside the single apply transaction, re-implementing the
//! SAME referential guards identity/registry enforce (active branches / active
//! users / non-terminal equipment / **active target region** for
//! `CreateBranch` and `RenameBranch{region_id: Some(_)}` — console-k6wm inverse
//! of `DeactivateRegion`); the DB constraints remain the second net.
/// OrgUnit owner-crate binding seam, compiled in-place via `#[path]` so this
/// adapter never takes a Cargo dependency on
/// `console-ontology-canonical-adapter-postgres` (adapter→adapter is illegal).
/// Writer-ownership still attributes the SQL to the owner path on disk.
#[path = "../../../ontology/canonical-adapter-postgres/src/org_unit_binding.rs"]
pub mod org_unit_binding;

use console_governance_domain::{Dependent, OnDelete, assess_impact};
use console_kernel_core::{
    AuditAction, AuditClassification, AuditEvent, ErrorKind, KernelError, OrgId, TraceContext,
    UserId,
};
use console_orgchange_domain::{
    ApprovalRoleKey, ApprovalStepView, BRANCH_BACKS_WORKPLACE, CanonicalResolutionStatus,
    ORG_CHANGE_SCHEDULED_CONTENT, ORG_CHANGE_SCHEDULED_LOCKED, OrgChangeDetail, OrgChangeEventView,
    OrgChangeKind, OrgChangePage, OrgChangeStatus, OrgChangeSummary, OrgChangeTarget,
    OrgEntitySummary, OrgProposalOp, OrgTreeNodeKind, OrgUnitDetailView, OrgUnitHeadView,
    OrgUnitKind, OrgUnitListView, OrgUnitMemberView, OrgUnitMembersView, OrgUnitReference,
    OrgUnitRevisionView, OrgUnitStatus, PreflightBlocker, PreflightReport, PreflightWarning,
    SITE_IS_A_WORKPLACE, SettlementItemView, SettlementKey, StepDecision, TargetKind, TreeEntry,
    refuse_retired, tree_order, validate_proposal,
};
use console_platform_db::{
    DbError, PeriodLockDomain, assert_period_open, with_audit, with_audits, with_org_conn,
};
use console_platform_request_context::current_org;
use console_settings_adapter_postgres::approval_routes_in_tx;
use console_settings_domain::SettingKey;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};
use std::{collections::BTreeMap, sync::Arc};
use time::{Date, OffsetDateTime, macros::offset};
use uuid::Uuid;

mod apply;
mod error;
mod freeze;
mod legacy_setup;
mod org_unit;
mod ports;
mod preflight;
mod rows;
mod schedule_time;
mod store;
mod types;
mod util;

use apply::*;
pub use error::*;
use freeze::*;
use legacy_setup::*;
use org_unit::*;
pub use ports::*;
use preflight::*;
use rows::*;
use schedule_time::*;
use store::*;
pub use types::*;
use util::*;

type Tx<'a, 'b> = &'a mut Transaction<'b, Postgres>;

#[derive(Clone)]
pub struct PgOrgChangeStore {
    pool: PgPool,
    /// The owning Employment port's transfer write, injected by the composition
    /// root. `None` (fail-closed) until wired: `ReassignOrgUnit` refuses rather
    /// than silently skipping the move.
    employment_transfer: Option<Arc<dyn EmploymentTransferPort>>,
    /// The owning OrgUnit port's in-transaction write, injected by the
    /// composition root. `None` fails the `*_ORG_UNIT` ops closed at apply.
    org_unit_write: Option<Arc<dyn OrgUnitWritePort>>,
}

impl PgOrgChangeStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            employment_transfer: None,
            org_unit_write: None,
        }
    }

    /// Wire the owning OrgUnit port's in-transaction write.
    #[must_use]
    pub fn with_org_unit_write(mut self, port: Arc<dyn OrgUnitWritePort>) -> Self {
        self.org_unit_write = Some(port);
        self
    }

    /// Wire the owning Employment port's transfer write. Without it
    /// `ReassignOrgUnit` fails closed at apply time rather than silently
    /// skipping the employee move.
    #[must_use]
    pub fn with_employment_transfer(mut self, port: Arc<dyn EmploymentTransferPort>) -> Self {
        self.employment_transfer = Some(port);
        self
    }

    /// The wired transfer port, as an owned `Arc` clone so the `with_audits`
    /// closure can hold it for the whole apply without borrowing `self`. `None`
    /// is legal for proposals with no `ReassignOrgUnit` op; the reassign arm
    /// itself fails closed when no port is wired.
    fn employment_transfer(&self) -> Option<Arc<dyn EmploymentTransferPort>> {
        self.employment_transfer.clone()
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

mod projection_refusal;
