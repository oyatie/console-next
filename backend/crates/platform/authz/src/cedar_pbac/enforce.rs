//! The live call for a Cedar-only action (BW-06 Cedar; decisions D0.1).
//! A use case passes the facts it computed inside its decision transaction;
//! only `Allow` passes. An unenrolled action, a missing, mistyped or extra
//! fact, a `forbid`, or no matching `permit` is a deny, so a route wired here
//! stays closed until its per-action schema is enrolled.

use console_kernel_core::KernelError;

use super::action_schema::{action_schema, compile_action_bundle};
use super::actions::deciding_reasons;
use super::facts::{Facts, evaluate_with_facts};
use super::{AuthorizationRequest, AuthorizationResource, CedarEvaluation};
use crate::{Action, Feature, Principal};

/// Decide `feature` on `resource` for `principal` with `facts`.
///
/// # Errors
/// `Forbidden` unless Cedar allows. The Cedar reason is never returned to the
/// client unless the action explicitly declares a stable refusal code.
pub fn enforce_action(
    principal: &Principal,
    feature: Feature,
    resource: AuthorizationResource,
    facts: &Facts,
) -> Result<(), KernelError> {
    let denied = || KernelError::forbidden(format!("{} is not allowed", feature.as_str()));
    let freshness = principal.authz_freshness;
    // compiled per call; cache by bundle key when a hot path needs it.
    let bundle = compile_action_bundle(principal.org_id, freshness.policy_version, feature)
        .map_err(|_| denied())?;
    let request = AuthorizationRequest::new(principal.clone(), Action::new(feature), resource)
        .with_subject_freshness(freshness);
    match evaluate_with_facts(&request, &bundle, facts) {
        CedarEvaluation::Allow { .. } => Ok(()),
        CedarEvaluation::Deny { reason, .. } => {
            let code = action_schema(feature).and_then(|schema| schema.denial_code(&reason));
            tracing::warn!(
                code = code.unwrap_or("forbidden"),
                action = feature.as_str(),
                "access refused"
            );
            Err(code.map_or_else(denied, |code| denied().with_code(code)))
        }
        _ => Err(denied()),
    }
}

/// Only annotations on deciding policies explain a denial; policy errors stay closed.
pub(super) fn denial_reason(
    policies: &cedar_policy::PolicySet,
    response: &cedar_policy::Response,
) -> String {
    let reasons = deciding_reasons(policies, response);
    if reasons.is_empty() {
        "cedar denied: no matching permit".to_owned()
    } else {
        reasons.join(",")
    }
}
