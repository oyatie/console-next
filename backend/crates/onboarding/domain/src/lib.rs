//! Tenant setup phase (entity-depth design §5–§6): the server-computed setup
//! rail, the 운영 시작 preview (blockers with their fix, warnings, what becomes
//! governed, counts, digest) and the Rust backstop of the go-live decision.
//! Pure: the adapter computes [`SetupFacts`] inside the transaction.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod checklist;
mod details;
mod modules;
mod preview;
mod preview_digest;

pub use checklist::{Checklist, Counts, Step, StepState, Summary, checklist};
pub use details::{Account, Breakdown, PreviewDetails, RoleActivation, TermsVersion};
pub use modules::{Module, readiness};
pub use preview::{Item, Preview, Record, Records, backstop, preview};
pub use preview_digest::{changed_codes, digest_lines};

use console_kernel_core::TenantPhase;
use serde::Serialize;

/// Everything the rail and the preview read, computed in one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct SetupFacts {
    pub phase_is_setup: bool,
    pub terms_accepted: bool,
    pub entities: i64,
    pub entities_needing_confirmation: i64,
    pub registrations: i64,
    pub registrations_needing_confirmation: i64,
    pub registrations_unverified: i64,
    pub entities_without_primary_workplace: i64,
    pub workplaces: i64,
    pub workplaces_incomplete: i64,
    /// Unanswered registration prompts for staffed workplaces; never a go-live blocker.
    pub staffed_workplaces_without_registration: i64,
    pub empty_workplaces_without_registration: i64,
    pub org_units: i64,
    pub org_step_skipped: bool,
    /// Active accounts Cedar lets decide an org change over the whole
    /// tenant (the ops account included; the actor counts). Computed only
    /// when org changes route (decisions #26); 0 otherwise.
    pub org_change_approvers: i64,
    /// The same holders, the actor excluded.
    pub other_eligible_holders: i64,
    /// `approval.policy.org_structure = route` (decisions #26): an org change
    /// after go-live needs approval steps. `false` (`none`, the default)
    /// applies it directly, so no approver is needed.
    pub org_change_routed: bool,
    pub security_contact_recorded: bool,
    /// #7's contact store has not landed yet; until it does the contact is a
    /// warning, never a blocker (a missing feature must not dead-end go-live).
    pub security_contact_store_available: bool,
    /// People employed today (재직 · 휴직): never a 입사 예정, a 퇴직 or a
    /// cancelled registration.
    pub employees: i64,
    /// 입사 예정 (PRE_HIRE): shown apart from the headcount.
    pub employees_starting_later: i64,
    pub employees_step_deferred: bool,
    pub unplaced_people: i64,
    pub unresolved_departments: i64,
    /// People employed today without a live department, counted from their records.
    pub people_without_department: i64,
    pub entity_unknown_people: i64,
    pub tenant_roles: i64,
    pub grants_effective_in_setup: i64,
    pub prepared_grants: i64,
    pub non_ops_grants: i64,
    pub hr_accounts_invited: i64,
    pub hr_accounts_enrolled: i64,
    pub roles_step_skipped: bool,
    pub access_admin_holders: i64,
    pub unmapped_assignments: i64,
    pub insurance_not_established_with_people: i64,
    pub insurance_numbers_pending: i64,
    pub org_changes_in_approval: i64,
    pub setup_writes: i64,
    /// The actor's own passkeys: with one, a lost device ends the account
    /// (and, for the only ops holder, the tenant's way in).
    pub own_passkeys: i64,
}

impl SetupFacts {
    #[must_use]
    pub fn phase(&self) -> TenantPhase {
        if self.phase_is_setup {
            TenantPhase::Setup
        } else {
            TenantPhase::Operating
        }
    }

    /// ≥ 1 entity; none (and none of its registrations) awaiting confirmation.
    #[must_use]
    pub fn entities_ready(&self) -> bool {
        self.entities > 0
            && self.entities_needing_confirmation == 0
            && self.registrations_needing_confirmation == 0
    }

    /// Every entity has a complete 대표 사업장. Registration answers are optional.
    #[must_use]
    pub fn primary_workplaces_ready(&self) -> bool {
        self.workplaces > 0
            && self.entities_without_primary_workplace == 0
            && self.workplaces_incomplete == 0
    }

    /// An org change after go-live can complete: it needs no approval
    /// (`approval.policy.org_structure = none`), or someone can decide it
    /// (the actor counts; see the preview's second-person warning).
    #[must_use]
    pub fn org_change_route_resolvable(&self) -> bool {
        !self.org_change_routed || self.org_change_approvers > 0
    }

    /// The go-live asks the sole holder to acknowledge being alone: only
    /// when org changes route through a second person (decisions #26).
    #[must_use]
    pub const fn sole_holder_ack_required(&self) -> bool {
        self.org_change_routed && self.other_eligible_holders == 0
    }
}

#[cfg(test)]
mod first_run_tests;

#[cfg(test)]
mod modules_tests;
