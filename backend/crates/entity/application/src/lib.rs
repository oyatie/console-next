//! 법인 · 사업장 use cases: command inputs and the read views the API returns.
//!
//! Commands carry the domain's raw inputs plus who is acting; the adapter
//! validates them with the domain, admits them against the tenant phase and
//! writes them in one audited transaction. Views are the wire shapes.

mod asof;
pub use asof::*;
mod entity_setup;
mod evidence;
pub mod name_evidence;
mod org_setup;
mod structure;
mod views;
mod workplace_kind;

// The workspace `time` build has no `serde-human-readable`: dates go on the
// wire as ISO `YYYY-MM-DD` (KST calendar dates) through this module.
time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

pub use entity_setup::*;
pub use evidence::*;
pub use org_setup::*;
pub use structure::*;
pub use views::*;
pub use workplace_kind::*;

use console_entity_domain::legal_entity::LegalEntityInput;
use console_entity_domain::registration::RegistrationInput;
use console_entity_domain::workplace::WorkplaceInput;
use console_kernel_core::{OrgId, TraceContext, UserId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Who is acting, resolved by the REST layer from the verified token.
#[derive(Debug, Clone)]
pub struct Actor {
    pub org: OrgId,
    pub user: UserId,
    pub trace: TraceContext,
    /// The write's command id (the request's `Idempotency-Key`, INTEG-1).
    /// Reads carry `None`; a write without one is refused (fail closed).
    pub command_id: Option<Uuid>,
    /// How far the caller's authority reaches; every read is filtered by it.
    pub scope: EntityScope,
}

/// What a 법인 administration write touches, for the scope rule's resource
/// ids: nothing yet (a new 법인: tenant scope only), or an existing record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Tenant,
    Entity(Uuid),
    Registration(Uuid),
    Workplace(Uuid),
}

/// The facts a grant's 업무위탁 basis is checked against (decisions #15.2;
/// `console_entity_domain::cross_entity::check_grant_basis`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct GrantBasisFacts {
    /// `authz.cross_entity_grant.basis_required` in force for the tenant.
    pub required: bool,
    /// The holder has an open employment at the target 법인 (or the grant
    /// targets the whole tenant).
    pub holder_employed_by_target: bool,
}

/// Where a caller's authority reaches (ED §3.11, decisions #15): the whole
/// tenant, or only the 법인 and 사업장 ids of their scope grants. A grant on a
/// 법인 that does not employ the holder is an ordinary grant (#15.3); without
/// one, nothing crosses (#15.4). Reads apply it as the SQL `WHERE` backstop of
/// the Cedar rule `scope_tenant || scope_entities.containsAny(resource)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntityScope {
    Tenant,
    Only(Vec<Uuid>),
}

impl EntityScope {
    /// The granted ids, `None` for the whole tenant (binds as SQL `NULL`).
    #[must_use]
    pub fn granted(&self) -> Option<&[Uuid]> {
        match self {
            Self::Tenant => None,
            Self::Only(ids) => Some(ids),
        }
    }
}

/// A revision of an existing record: the full new state, when it takes
/// effect, and why (BW-07 reason code).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revision<T> {
    /// The version the client read; a later revision since then is 409
    /// `stale_revision` (INTEG-2). Required.
    pub expected_version: Option<i32>,
    pub effective_from: Option<String>,
    pub reason_code: Option<String>,
    #[serde(flatten)]
    pub input: T,
}

pub type LegalEntityRevision = Revision<LegalEntityInput>;
pub type RegistrationRevision = Revision<RegistrationInput>;
pub type WorkplaceRevision = Revision<WorkplaceInput>;

/// A 사업자등록's confirmed status in a revision: 계속, 휴업 (from
/// `status_since`, expected to end `status_until`) or 폐업.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RegistrationStatusInput {
    pub status: Option<String>,
    pub status_since: Option<String>,
    pub status_until: Option<String>,
}

/// 등록증 재발급·정정 (`POST /business-registrations/{id}/reissues`): the new
/// certificate, why and from when, the registration's full new state and, when
/// the certificate changed what the 법인 records (대표자, 법인명, 본점), the
/// 법인's full new state. One dated, evidenced change in one transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistrationReissue {
    pub document_id: Option<Uuid>,
    /// `CERT_REISSUE`, `CERT_CHANGE_REPORT` or `CERT_ERROR_CORRECTION`.
    pub reason: Option<String>,
    /// From when the certificate's facts hold (정정일).
    pub effective_from: Option<String>,
    pub registration: ReissuedRegistration,
    #[serde(default)]
    pub entity: Option<ReissuedEntity>,
}

/// The registration's state as the new certificate prints it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReissuedRegistration {
    pub expected_version: Option<i32>,
    #[serde(flatten)]
    pub input: RegistrationInput,
    #[serde(flatten)]
    pub status: RegistrationStatusInput,
}

/// The 법인's state with what the certificate changed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReissuedEntity {
    pub expected_version: Option<i32>,
    #[serde(flatten)]
    pub input: LegalEntityInput,
}

/// The 4대보험 relations a dated insurance change sets (only those listed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsuranceChange {
    #[serde(default)]
    pub insurers: Vec<console_entity_domain::insurance::InsurerInput>,
}

/// `expected_version` is the highest insurance version of the 사업장 read.
pub type InsuranceRevision = Revision<InsuranceChange>;

/// Create a workplace under an entity, optionally marking its role.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkplace {
    #[serde(flatten)]
    pub input: WorkplaceInput,
    /// 대표 사업장. The first 사업장 of an entity is primary as a fact.
    pub is_primary: Option<bool>,
    /// 본점 사업장 (원천징수 납세지 for a 법인).
    pub is_head_office: Option<bool>,
    /// Bind an existing, unbound branch instead of creating one (INTEG-5:
    /// branches are never matched by name).
    pub default_branch_id: Option<Uuid>,
    /// 사업장 kind (decisions #18): a platform default or a tenant code; a
    /// label only. Absent = 미지정.
    pub kind_code: Option<String>,
}

/// Entity-level roles of its 사업장 (대표 / 본점), set together.
/// Settle a [`NameReview`]: without `revision` the entity's name stays; with it,
/// the registration's 상호 becomes the name by that dated 정정.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettleNameReview {
    pub revision: Option<LegalEntityRevision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityRoles {
    pub primary_workplace_id: Option<Uuid>,
    pub head_office_workplace_id: Option<Uuid>,
    #[serde(default)]
    pub head_office_has_no_workplace: bool,
}

/// Close a 법인 (MR-15): 해산 or 폐업 on a date no later than today. Its open
/// 사업장 and 사업자등록 close with it; refused while people are still placed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseLegalEntity {
    pub closed_on: Option<String>,
    pub reason_code: Option<String>,
}

/// Correct a 법인's recorded close (catalog company-19): the right 종료일 and
/// 종료 사유, and why the first record was wrong. It never reopens the 법인.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseCorrection {
    pub closed_on: Option<String>,
    pub reason_code: Option<String>,
    pub why: Option<String>,
}

/// Withdraw a 법인's recorded close (종료 취소, catalog company-19): the
/// business goes on. The 사업장 and 사업자등록 that closed with it reopen;
/// `why` is kept in the audit row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseWithdrawal {
    pub why: Option<String>,
}

/// Undo a mistaken record during setup (no downstream rows allowed).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoidRecord {
    pub reason_code: Option<String>,
}

/// Bind an employee to a 법인 and 사업장 from a date (INTEG seam: the hr
/// create/transfer transaction will call this through a port; until then the
/// client calls it right after registering).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindAssignment {
    pub employee_id: Uuid,
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    pub valid_from: Option<String>,
}

/// 「회사 이름 정리」: map every unmapped employee whose company text is
/// `company_text` to one 법인 (and optionally one 사업장), per text not per person.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapCompanyText {
    pub company_text: Option<String>,
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
}

/// A 부서 created during setup without an org-change proposal (one op of
/// [`OrgSetupBatch`]). The level is inferred from where it goes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSetupOrgUnit {
    pub name: Option<String>,
    /// Retired (decisions #18): `DEPARTMENT` or `TEAM` are accepted and
    /// ignored; any other value is refused.
    pub kind: Option<String>,
    /// The 사업장 a top-level 부서 sits in.
    pub workplace_id: Option<Uuid>,
    /// The parent 부서 (or 사업장 unit), for nested 부서.
    pub parent_org_unit_id: Option<Uuid>,
}

/// Rename and/or move one 부서 during setup (one or two ops of
/// [`OrgSetupBatch`]). `expected_version` pins the version the client read;
/// absent, the change applies to whatever is current (legacy clients).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameSetupOrgUnit {
    pub name: Option<String>,
    pub expected_version: Option<i32>,
    #[serde(flatten)]
    pub parent: OrgParent,
}

mod compare;
pub use compare::*;

mod structure_views;
pub use structure_views::*;
