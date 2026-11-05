// SPDX-License-Identifier: LicenseRef-Proprietary
//! Access requests remain self-service; support sessions cannot mutate them.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "access_request_write";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action access_request_write appliesTo { principal: [Subject], resource: [Resource],
context: { "support_session": Bool, "operation": String, "is_requester": Bool, "can_manage": Bool } };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"access_request_write", resource)
when {
  principal.org == resource.org && !context.support_session &&
  (context.operation == "CREATE" ||
   (context.operation == "WITHDRAWN" && context.is_requester) ||
   (["DONE", "DECLINED"].contains(context.operation) && context.can_manage))
};"#;

pub(crate) fn decide(
    actor: &str,
    org: &str,
    roles: &[String],
    facts: &[(&str, Fact)],
) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            actor,
            org,
            &roles.iter().map(String::as_str).collect::<Vec<_>>(),
            org,
            facts,
        )
}
