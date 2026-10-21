//! The typed attributes, query and command the canonical port accepts.

use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_domain::{CanonicalQuery, CommandId, DispatchTarget};
use serde::Deserialize;
use time::OffsetDateTime;
use uuid::Uuid;

/// The canonical state of one employment at one version. Typed rather than raw
/// JSONB because the port applies the same four values to the legacy head, and
/// `employees.employment_status` carries a CHECK that a free-form payload would
/// only discover at 23514.
///
/// `org_unit_id` / `job_position_id` are canonical OrgUnit / JobPosition UUIDs
/// (L5-ORG / L5-JOB). Free-text team or title labels are not authority. The
/// legacy `employees.org_unit` / `employees.position` TEXT columns store the
/// UUID string form so REST/org-chart readers keep a single column without a
/// parallel free-text namespace.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EmploymentAttributes {
    /// Empty until placement supplies a company label (minimum registration).
    pub company: String,
    pub org_unit_id: Option<Uuid>,
    pub job_position_id: Option<Uuid>,
    pub employment_status: String,
}

/// The statuses `employees.employment_status` admits (0066's CHECK, widened
/// with ON_LEAVE by 0243).
pub(super) const EMPLOYMENT_STATUSES: [&str; 4] = ["ACTIVE", "ON_LEAVE", "EXITED", "UNKNOWN"];

impl EmploymentAttributes {
    /// The revision's `attributes` JSONB. Keys are written in sorted order, so
    /// the value and its digest do not depend on this struct's field order.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "company": self.company,
            "employment_status": self.employment_status,
            "job_position_id": self.job_position_id.map(|id| id.to_string()),
            "org_unit_id": self.org_unit_id.map(|id| id.to_string()),
        })
    }

    /// Legacy-head TEXT projections of the canonical UUID attrs.
    #[must_use]
    pub fn legacy_org_unit_text(&self) -> Option<String> {
        self.org_unit_id.map(|id| id.to_string())
    }

    /// Legacy-head TEXT projections of the canonical UUID attrs.
    #[must_use]
    pub fn legacy_position_text(&self) -> Option<String> {
        self.job_position_id.map(|id| id.to_string())
    }
}

/// The typed read this port answers: the write a caller intends, and nothing
/// about how it is performed. Each variant is bound to exactly one of the three
/// dispatch targets the contract assigns to `Employment`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "target")]
pub enum EmploymentQuery {
    /// `hr.appoint`. Opens a head at `valid_from`, appends revision 1, and binds
    /// the head to the legacy `employees` row this employment IS. The legacy row
    /// is not rewritten: it was just created with these values.
    #[serde(rename = "hr.appoint")]
    Appoint {
        employee_id: Uuid,
        #[serde(with = "time::serde::rfc3339")]
        valid_from: OffsetDateTime,
        attributes: EmploymentAttributes,
    },
    /// `hr.promote`. Appends a revision to an existing head and carries the new
    /// state onto the legacy head.
    #[serde(rename = "hr.promote")]
    Promote {
        employment_id: Uuid,
        #[serde(with = "time::serde::rfc3339")]
        valid_from: OffsetDateTime,
        attributes: EmploymentAttributes,
    },
    /// `hr.transfer`. Same shape as a promotion — the difference is the
    /// dispatch target the receipt records, which is what an auditor reads.
    #[serde(rename = "hr.transfer")]
    Transfer {
        employment_id: Uuid,
        #[serde(with = "time::serde::rfc3339")]
        valid_from: OffsetDateTime,
        attributes: EmploymentAttributes,
    },
}

impl EmploymentQuery {
    /// The dispatch target this query is, spelled once in `canonical-domain`.
    #[must_use]
    pub const fn target(&self) -> DispatchTarget {
        match self {
            Self::Appoint { .. } => DispatchTarget::HrAppoint,
            Self::Promote { .. } => DispatchTarget::HrPromote,
            Self::Transfer { .. } => DispatchTarget::HrTransfer,
        }
    }

    #[must_use]
    pub const fn attributes(&self) -> &EmploymentAttributes {
        match self {
            Self::Appoint { attributes, .. }
            | Self::Promote { attributes, .. }
            | Self::Transfer { attributes, .. } => attributes,
        }
    }

    #[must_use]
    pub const fn valid_from(&self) -> OffsetDateTime {
        match self {
            Self::Appoint { valid_from, .. }
            | Self::Promote { valid_from, .. }
            | Self::Transfer { valid_from, .. } => *valid_from,
        }
    }
}

impl CanonicalQuery for EmploymentQuery {
    fn dispatch_target(&self) -> DispatchTarget {
        self.target()
    }

    /// Promote/Transfer name the employment head they revise. Without this, the
    /// projected-dispatch `target_id` bind skips (trait default `None`) and a
    /// four-eyes approval for employment I can be spent while the port revises J.
    fn subject_id(&self) -> Option<Uuid> {
        match self {
            Self::Appoint { .. } => None,
            Self::Promote { employment_id, .. } | Self::Transfer { employment_id, .. } => {
                Some(*employment_id)
            }
        }
    }
}

/// The typed write this port accepts. `org_id` is the RLS key and `command_id`
/// the tenant-global idempotency key; a repeat replays the stored receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmploymentCommand {
    pub org_id: OrgId,
    pub command_id: CommandId,
    pub actor_id: UserId,
    pub query: EmploymentQuery,
    pub action_key: String,
    pub object_type_id: Uuid,
}
