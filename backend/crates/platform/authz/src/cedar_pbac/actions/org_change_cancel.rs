// SPDX-License-Identifier: LicenseRef-Proprietary
//! Withdrawing a submitted document belongs to its drafter, even after a grant ends.
use super::{ActionBundle, Fact};
use console_kernel_core::KernelError;
use std::sync::OnceLock;

const ACTION: &str = "org_change_cancel";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action org_change_cancel appliesTo { principal: [Subject], resource: [Resource],
  context: { "holds_permission": Bool, "actor_is_drafter": Bool, "in_approval": Bool }
};"#;
const POLICIES: &str = r#"permit(principal, action == Action::"org_change_cancel", resource)
when { principal.org == resource.org &&
  (if context.in_approval then context.actor_is_drafter else context.holds_permission) };
@reason("org_change.refuse.not_drafter")
forbid(principal, action == Action::"org_change_cancel", resource)
when { context.in_approval && !context.actor_is_drafter };
"#;

#[derive(Debug, Clone, Copy)]
pub struct Facts {
    pub holds_permission: bool,
    pub actor_is_drafter: bool,
    pub in_approval: bool,
}

pub fn enforce(
    actor: &str,
    org: &str,
    resource_org: &str,
    facts: Facts,
) -> Result<(), KernelError> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    let decision = BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|bundle| {
            bundle.decide_with_reasons(
                actor,
                org,
                &[],
                resource_org,
                &[
                    ("holds_permission", Fact::Bool(facts.holds_permission)),
                    ("actor_is_drafter", Fact::Bool(facts.actor_is_drafter)),
                    ("in_approval", Fact::Bool(facts.in_approval)),
                ],
            )
        });
    match decision {
        Ok((true, _)) => Ok(()),
        Ok((false, reasons))
            if facts.holds_permission
                && reasons.iter().any(|r| r == "org_change.refuse.not_drafter") =>
        {
            Err(KernelError::forbidden(
                "only the drafter can withdraw a submitted change; ask the drafter to withdraw it",
            )
            .with_code("org_change.refuse.not_drafter"))
        }
        Ok((false, _)) if org == resource_org && facts.actor_is_drafter => Err(
            KernelError::forbidden("org-change draft permission required")
                .with_code("org_change.refuse.missing_grant"),
        ),
        _ => Err(KernelError::not_found("org-change request was not found")
            .with_code("org_change.refuse.missing_grant")),
    }
}

#[cfg(test)]
#[path = "org_change_cancel_tests.rs"]
mod tests;
