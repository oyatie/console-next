//! `change_request_decide` (BW-17; governance S10; decisions #7). Applying or
//! declining a change request (변경 요청) filed by someone else. The holder is
//! the org-wide HR tier, or the named assignee of an answer kind (소명 요청,
//! 규정 질의). The requester never decides their own request, except as the
//! decisions #7 case-B sole-holder fallback: no other eligible holder, a
//! step-up bound to the payload, and `authz.sole_holder.mode` is not `refuse`
//! (a 정정 of pay or dates by a one-person HR tenant), or when the tenant's
//! `approval.policy.<class>` is `none` (decisions #26: no second person is
//! required, so the actor applies it after the same step-up).
//! Withdrawal is the requester's own act and is not decided here.
//! Backstop: `check_close` in hr-domain and the `decided_by <> requested_by`
//! CHECK (the sole-holder path writes no decider).

use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::second_person::{
    ACTOR_HOLDS_PERMISSION, ACTOR_IS_REQUESTER, OTHER_ELIGIBLE_HOLDERS, SOLE_HOLDER_MODE, STEP_UP,
};
use crate::Feature;

/// `approval.policy.<class> = route` for the change (decisions #26).
pub const APPROVAL_ROUTED: RequiredFact = RequiredFact {
    name: "approval_routed",
    ty: FactType::Bool,
};

/// The decision applies the request (`false`: a decline).
pub const IS_APPLY: RequiredFact = RequiredFact {
    name: "is_apply",
    ty: FactType::Bool,
};

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[],
    feature: Feature::ChangeRequestDecide,
    version: "2026-10-d26-change-request-decide-v2",
    facts: &[
        ACTOR_IS_REQUESTER,
        ACTOR_HOLDS_PERMISSION,
        OTHER_ELIGIBLE_HOLDERS,
        STEP_UP,
        SOLE_HOLDER_MODE,
        IS_APPLY,
        APPROVAL_ROUTED,
    ],
    policies: r#"permit(principal, action == Action::"change_request_decide", resource)
when {
  principal.org == resource.org &&
  context.actor_holds_permission
};
@reason("authz_sod_requester")
forbid(principal, action == Action::"change_request_decide", resource)
when { context.actor_is_requester }
unless {
  context.is_apply &&
  context.step_up &&
  ((context.other_eligible_holders == 0 &&
    context.sole_holder_mode == "step_up_notice_review") ||
   !context.approval_routed)
};
"#,
};
