//! Cedar `change_request_decide` (BW-17; decisions #7): the authoritative
//! "who may" for applying or declining a change request, and for a sole
//! holder applying their own high-risk 정정 or merge. The domain
//! `check_close` and the DB CHECK stay the backstop.

use console_kernel_core::KernelError;
use console_platform_authz::cedar_pbac::action_schema::compile_action_bundle;
use console_platform_authz::cedar_pbac::facts::{Facts, evaluate_with_facts};
use console_platform_authz::{
    Action, AuthorizationRequest, AuthorizationResource, CedarEvaluation, Feature, Principal,
};

use crate::HrError;
use crate::corrections::SecondPersonContext;

/// Server-computed facts of one decision, taken inside its transaction.
#[derive(Debug, Clone, Copy)]
pub struct DecideFacts {
    pub actor_is_requester: bool,
    pub actor_holds_permission: bool,
    pub holders: SecondPersonContext,
    pub step_up: bool,
    pub is_apply: bool,
}

/// Allow or `Forbidden`. A missing schema, a fact error or no permit denies.
pub fn enforce_change_request_decide(
    principal: &Principal,
    resource_type: &str,
    resource_id: String,
    facts: DecideFacts,
) -> Result<(), HrError> {
    let feature = Feature::ChangeRequestDecide;
    let denied = || {
        HrError::from_kernel(KernelError::forbidden(
            "change_request_decide is not allowed",
        ))
    };
    let freshness = principal.authz_freshness;
    // local copy of cedar_pbac::enforce::enforce_action (F-EXC,
    // not on trunk yet); swap to it once it lands. Compiled per call.
    let bundle = compile_action_bundle(principal.org_id, freshness.policy_version, feature)
        .map_err(|_| denied())?;
    let resource = AuthorizationResource::org_wide(principal.org_id, resource_type)
        .with_resource_id(resource_id);
    let request = AuthorizationRequest::new(principal.clone(), Action::new(feature), resource)
        .with_subject_freshness(freshness);
    let other = i64::try_from(facts.holders.other_eligible_holders).unwrap_or(i64::MAX);
    let mode = if facts.holders.sole_holder_refuse {
        "refuse"
    } else {
        "step_up_notice_review"
    };
    let cedar_facts = Facts::new()
        .bool("actor_is_requester", facts.actor_is_requester)
        .bool("actor_holds_permission", facts.actor_holds_permission)
        .long("other_eligible_holders", other)
        .bool("step_up", facts.step_up)
        .string("sole_holder_mode", mode)
        .bool("is_apply", facts.is_apply)
        .bool("approval_routed", facts.holders.routed);
    match evaluate_with_facts(&request, &bundle, &cedar_facts) {
        CedarEvaluation::Allow { .. } => Ok(()),
        _ => Err(denied()),
    }
}

/// The decisions #7 case-B self-decision of an org-wide HR holder: the actor
/// requests and decides at once, after a verified step-up. Cedar refuses it
/// while another eligible holder exists or the tenant refuses sole holders.
pub fn sole_holder_cedar(
    principal: &Principal,
    employee_id: uuid::Uuid,
    holders: SecondPersonContext,
) -> Result<(), HrError> {
    let facts = DecideFacts {
        actor_is_requester: true,
        actor_holds_permission: true,
        holders,
        step_up: true,
        is_apply: true,
    };
    enforce_change_request_decide(principal, "employee", employee_id.to_string(), facts)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use console_kernel_core::{BranchScope, OrgId, UserId};
    use console_platform_authz::{Principal, Role};

    use super::{DecideFacts, SecondPersonContext, enforce_change_request_decide};

    fn holders(other: u64, refuse: bool) -> SecondPersonContext {
        SecondPersonContext {
            other_eligible_holders: other,
            sole_holder_refuse: refuse,
            routed: true,
        }
    }

    fn allowed(requester: bool, holds: bool, h: SecondPersonContext, step_up: bool) -> bool {
        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let facts = DecideFacts {
            actor_is_requester: requester,
            actor_holds_permission: holds,
            holders: h,
            step_up,
            is_apply: true,
        };
        enforce_change_request_decide(&principal, "change_request", "r".into(), facts).is_ok()
    }

    #[test]
    fn a_second_holder_decides_and_the_requester_only_as_a_stepped_up_sole_holder() {
        assert!(allowed(false, true, holders(1, false), false));
        assert!(!allowed(false, false, holders(1, false), false));
        assert!(!allowed(true, true, holders(1, false), true));
        assert!(!allowed(true, true, holders(0, false), false));
        assert!(!allowed(true, true, holders(0, true), true));
        assert!(allowed(true, true, holders(0, false), true));
    }

    #[test]
    fn under_approval_policy_none_the_stepped_up_requester_applies() {
        let none = |other, refuse| SecondPersonContext {
            routed: false,
            ..holders(other, refuse)
        };
        assert!(allowed(true, true, none(2, false), true));
        assert!(allowed(true, true, none(0, true), true));
        assert!(!allowed(true, true, none(2, false), false), "step-up stays");
        assert!(!allowed(true, false, none(2, false), true));
    }
}
