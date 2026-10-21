//! The live call for a Cedar-only action (BW-06 Cedar; decisions D0.1).
//! A use case passes the facts it computed inside its decision transaction;
//! only `Allow` passes. An unenrolled action, a missing, mistyped or extra
//! fact, a `forbid`, or no matching `permit` is a deny, so a route wired here
//! stays closed until its per-action schema is enrolled.

use console_kernel_core::KernelError;

use super::action_schema::compile_action_bundle;
use super::facts::{Facts, evaluate_with_facts};
use super::{AuthorizationRequest, AuthorizationResource, CedarEvaluation};
use crate::{Action, Feature, Principal};

/// Decide `feature` on `resource` for `principal` with `facts`.
///
/// # Errors
/// `Forbidden` unless Cedar allows. The Cedar reason is never returned to the
/// client; the message names only the action.
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
        _ => Err(denied()),
    }
}
