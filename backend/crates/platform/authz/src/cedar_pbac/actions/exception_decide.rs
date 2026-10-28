//! `exception_decide` (BW-06 Cedar; decisions #5, #7; governance design §2.2).
//! The second person approves or declines a PENDING governed exception. The
//! requester and anyone who drafted or edited the subject never decide it.
//! Holders are rule-specific (for `LIFECYCLE_BACKDATED_CLOSED_PERIOD` the
//! period-lock managers), so the use case computes `actor_holds_permission`
//! inside the decision transaction. An approval needs a step-up of kind
//! `EXCEPTION_DECIDE` bound to the payload hash; a decline does not.
//! Backstop: the `no_self_decision` CHECK and the domain `decide` rules.
//! Enforced and fail-closed from the start: there is no legacy decision.
//! Design §2.2 also lists `rule_code` and `other_eligible_holders`; no rule
//! here reads them, so they are not required until one does (the SUPER_ADMIN
//! second person for the policy-change codes arrives with GOV-EXC-1).

use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::second_person::{
    ACTOR_CONTRIBUTED, ACTOR_HOLDS_PERMISSION, ACTOR_IS_REQUESTER, STEP_UP,
};
use crate::Feature;

/// The decision is an approval (`false`: a decline).
pub const IS_APPROVAL: RequiredFact = RequiredFact {
    name: "is_approval",
    ty: FactType::Bool,
};

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[],
    feature: Feature::ExceptionDecide,
    version: "2026-10-bw06-exception-decide-v1",
    facts: &[
        ACTOR_IS_REQUESTER,
        ACTOR_CONTRIBUTED,
        ACTOR_HOLDS_PERMISSION,
        STEP_UP,
        IS_APPROVAL,
    ],
    policies: r#"@reason("authz_sod_requester")
forbid(principal, action == Action::"exception_decide", resource)
when { context.actor_is_requester };
@reason("authz_sod_contributor")
forbid(principal, action == Action::"exception_decide", resource)
when { context.actor_contributed };
permit(principal, action == Action::"exception_decide", resource)
when {
  principal.org == resource.org &&
  context.actor_holds_permission &&
  (context.step_up || !context.is_approval)
};
"#,
};
