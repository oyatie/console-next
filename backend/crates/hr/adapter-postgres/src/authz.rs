//! The HR authorization gates, called inside the `HrService` bodies.

use console_kernel_core::{BranchId, BranchScope, KernelError};
use console_platform_authz::{
    Action, Feature, Principal, authorize, authorize_capability, authorize_org_wide,
};
use uuid::Uuid;

use crate::HrError;

#[path = "authz_case_facts.rs"]
mod case_facts;
#[path = "authz_person.rs"]
mod person;
pub use case_facts::HrCaseFacts;
#[path = "authz_reach.rs"]
mod reach;
pub use person::{
    APPOINTMENT_KEYS, Tier, authorize_hr_case, authorize_hr_person, authorize_hr_person_any,
    authorize_hr_person_in, authorize_hr_place, authorize_hr_place_any, hr_may_person,
    hr_may_person_in, hr_reach, hr_reach_any, hr_reach_in,
};
pub use reach::{
    HrReach, HrScope, holds_scoped, out_of_scope, person_in_reach, place_in_reach, push_reach,
    push_reach_at_unit, push_subject_in_reach, scope_tenant_wide_only,
};

/// The whole-tenant gate. A caller that holds the key only over part of the
/// tenant (AX-5) gets the typed `scope_tenant_wide_only`, so every door still
/// on this gate says why instead of a bare 403.
pub fn authorize_hr_org_wide(principal: &Principal, feature: Feature) -> Result<(), HrError> {
    authorize_org_wide(principal, Action::new(feature)).map_err(|err| {
        if holds_scoped(principal, feature) {
            scope_tenant_wide_only(principal, feature)
        } else {
            HrError::from_kernel(err)
        }
    })
}

/// Attendance manager routes are explicit about whether a concrete branch was
/// requested. A missing query parameter is an org-wide request; it is never
/// inferred from the caller's branch membership.
pub fn authorize_hr_attendance_branch_query(
    principal: &Principal,
    feature: Feature,
    branch_id: Option<Uuid>,
) -> Result<Option<Uuid>, HrError> {
    match branch_id {
        Some(branch_id) => {
            authorize(
                principal,
                Action::new(feature),
                BranchId::from_uuid(branch_id),
            )
            .map_err(HrError::from_kernel)?;
            Ok(Some(branch_id))
        }
        None => {
            authorize_hr_org_wide(principal, feature)?;
            Ok(None)
        }
    }
}

pub fn authorize_hr_scoped(principal: &Principal, feature: Feature) -> Result<(), HrError> {
    let action = Action::new(feature);
    match &principal.branch_scope {
        // Preserve the existing org-wide tier: collapsing this arm into the
        // capability check would admit an all-scoped ADMIN to a surface that
        // authorize_org_wide deliberately reserves for its org-wide roles.
        BranchScope::All => authorize_hr_org_wide(principal, feature),
        // The dashboard/store confines rows to the caller's complete scope. No
        // concrete resource branch exists at this preflight point, so selecting
        // one of the principal's own branches would make authorization vacuous.
        BranchScope::Branches(_) => {
            authorize_capability(principal, action).map_err(HrError::from_kernel)
        }
    }
}

/// Enforce the second-tier (HQ) separation of duties for an exit-case
/// confirmation. Called only after the `ExitCaseHqConfirm` capability check has
/// passed. The stored case state plus the distinct-actor rule — never the
/// client `hq_confirmation` boolean — is the authority: HQ confirmation is
/// allowed only when the case is already `HR_CONFIRMED` AND the recorded HR
/// confirmer is a DIFFERENT actor than the one now attempting HQ confirmation.
pub fn authorize_exit_confirmation_hq_tier(
    current_status: &str,
    hr_confirmed_by: Option<Uuid>,
    actor: Uuid,
) -> Result<(), HrError> {
    if current_status != "HR_CONFIRMED" {
        return Err(HrError::from_kernel(KernelError::invalid_transition(
            "HQ confirmation requires a prior HR confirmation",
        )));
    }
    match hr_confirmed_by {
        Some(hr_actor) if hr_actor == actor => Err(HrError::from_kernel(KernelError::forbidden(
            "HQ confirmation must be performed by a different actor than the HR confirmer",
        ))),
        Some(_) => Ok(()),
        None => Err(HrError::from_kernel(KernelError::invalid_transition(
            "HQ confirmation requires a recorded HR confirmer",
        ))),
    }
}

/// Who stands as the HQ tier's second person (decisions #26 item d), for the
/// confirmation's audit row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HqSecondPerson {
    /// `approval.policy.exit = none`: the HR confirmer finishes the tier.
    NotRequired,
    /// `route`, and someone other than the HR confirmer confirms.
    Distinct,
    /// `route`, and the tenant ops account confirms its own HR confirmation:
    /// break-glass, only after a passkey step-up (the caller checks it).
    OpsBreakGlass,
}

/// The HQ tier under `approval.policy.exit` (decisions #26): `route` keeps
/// [`authorize_exit_confirmation_hq_tier`]'s distinct-actor rule except for
/// the tenant ops account, which may be that second person (item d); `none`
/// keeps only the order (HR first), so a one-HR tenant can finish its exits.
pub fn exit_hq_second_person(
    current_status: &str,
    hr_confirmed_by: Option<Uuid>,
    actor: Uuid,
    routed: bool,
    actor_is_ops: bool,
) -> Result<HqSecondPerson, HrError> {
    let Some(hr_actor) = hr_confirmed_by.filter(|_| current_status == "HR_CONFIRMED") else {
        return Err(HrError::from_kernel(KernelError::invalid_transition(
            "HQ confirmation requires a prior HR confirmation",
        )));
    };
    if !routed {
        Ok(HqSecondPerson::NotRequired)
    } else if hr_actor != actor {
        Ok(HqSecondPerson::Distinct)
    } else if actor_is_ops {
        Ok(HqSecondPerson::OpsBreakGlass)
    } else {
        Err(crate::corrections::refusal(
            http::StatusCode::FORBIDDEN,
            "exit_hq_second_person_required",
            "HQ confirmation must be performed by a different actor than the HR confirmer",
        ))
    }
}

pub fn authorize_hr_scoped_write(
    principal: &Principal,
    feature: Feature,
    branch_id: Option<Uuid>,
) -> Result<(), HrError> {
    if let Some(branch_id) = branch_id {
        return authorize(
            principal,
            Action::new(feature),
            BranchId::from_uuid(branch_id),
        )
        .map_err(HrError::from_kernel);
    }
    // A branchless employee/case cannot be confined to one of the caller's
    // branches. Require true org-wide authority instead of treating the write as
    // a branchless capability over a branch-scoped principal.
    authorize_hr_org_wide(principal, feature)
}

pub fn authorize_home_branch_transition(
    principal: &Principal,
    prior_branch_id: Option<Uuid>,
    target_branch_id: Uuid,
) -> Result<(), HrError> {
    authorize(
        principal,
        Action::new(Feature::EmployeeDirectoryManage),
        BranchId::from_uuid(target_branch_id),
    )
    .map_err(HrError::from_kernel)?;
    match prior_branch_id {
        Some(prior_branch_id) => authorize(
            principal,
            Action::new(Feature::EmployeeDirectoryManage),
            BranchId::from_uuid(prior_branch_id),
        )
        .map_err(HrError::from_kernel),
        None => authorize_hr_org_wide(principal, Feature::EmployeeDirectoryManage),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_policy_none_lets_the_hr_confirmer_finish_the_hq_tier() {
        let hr = Uuid::new_v4();
        let by = |actor, routed, ops| {
            exit_hq_second_person("HR_CONFIRMED", Some(hr), actor, routed, ops)
        };
        assert_eq!(
            by(hr, false, false).ok(),
            Some(HqSecondPerson::NotRequired),
            "none: same actor"
        );
        assert_eq!(
            by(Uuid::new_v4(), true, false).ok(),
            Some(HqSecondPerson::Distinct)
        );
        assert_eq!(
            by(hr, true, true).ok(),
            Some(HqSecondPerson::OpsBreakGlass),
            "route: ops may be the second person"
        );
        assert!(
            exit_hq_second_person("REPORTED", None, hr, false, true).is_err(),
            "none keeps the order, even for ops"
        );
        assert!(
            exit_hq_second_person("HR_CONFIRMED", None, hr, true, true).is_err(),
            "no recorded HR confirmer"
        );
    }

    /// regression (decisions #26 item d): under `route` a non-ops HR confirmer
    /// is still refused, with its own code, and it stays refused.
    #[test]
    fn route_still_refuses_the_same_non_ops_actor() {
        let hr = Uuid::new_v4();
        let refused = exit_hq_second_person("HR_CONFIRMED", Some(hr), hr, true, false)
            .err()
            .map(|err| (err.status, err.code));
        assert_eq!(
            refused,
            Some((
                http::StatusCode::FORBIDDEN,
                "exit_hq_second_person_required"
            ))
        );
    }
}
