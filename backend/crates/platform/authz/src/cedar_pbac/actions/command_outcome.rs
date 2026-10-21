//! Outcome ownership and record-read overlay. Every fact is server-computed.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;
pub const ACTION: &str = "command_outcome_view";
pub const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action command_outcome_view appliesTo { principal:[Subject], resource:[Resource],
context: { "is_owner":Bool, "can_read_record":Bool } };"#;
pub const POLICIES: &str = r#"permit(principal, action == Action::"command_outcome_view", resource)
when { principal.org == resource.org && (context.is_owner || context.can_read_record) };"#;
pub fn decide(actor: &str, org: &str, owner: bool, readable: bool) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    let bundle = BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?;
    bundle.decide(
        actor,
        org,
        &[],
        org,
        &[
            ("is_owner", Fact::Bool(owner)),
            ("can_read_record", Fact::Bool(readable)),
        ],
    )
}
#[cfg(test)]
mod tests {
    #[test]
    fn owner_can_check_but_a_stranger_without_read_is_refused() {
        assert_eq!(super::decide("a", "o", true, false), Ok(true));
        assert_eq!(super::decide("a", "o", false, true), Ok(true));
        assert_eq!(super::decide("a", "o", false, false), Ok(false));
    }
    #[test]
    fn missing_facts_and_foreign_tenant_fail_closed() {
        let bundle =
            super::ActionBundle::compile(super::ACTION, super::SCHEMA, super::POLICIES).unwrap();
        assert!(bundle.decide("a", "o", &[], "o", &[]).is_err());
        assert_eq!(
            bundle.decide(
                "a",
                "o",
                &[],
                "x",
                &[
                    ("is_owner", super::Fact::Bool(true)),
                    ("can_read_record", super::Fact::Bool(true))
                ]
            ),
            Ok(false)
        );
    }
}
