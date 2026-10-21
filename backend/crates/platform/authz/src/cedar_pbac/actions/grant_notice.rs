//! A grant's holder confirms its notice (decisions D0.2: a grant counts toward
//! a second person only after its holder was told). Only the holder of a live
//! grant of their own tenant may; the use case computes both facts from the
//! grant row it locked.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "grant_notice_confirm";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action grant_notice_confirm appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "is_holder": Bool, "grant_live": Bool }
};"#;
const POLICIES: &str = r#"permit (principal, action == Action::"grant_notice_confirm", resource)
when { principal.org == resource.org && context.is_holder && context.grant_live };"#;

fn bundle() -> Result<&'static ActionBundle, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

/// Whether `user` of `org` may confirm the notice of a grant in `grant_org`.
/// Compilation or evaluation diagnostics are a refusal.
#[must_use]
pub fn decide(user: &str, org: &str, grant_org: &str, is_holder: bool, grant_live: bool) -> bool {
    bundle()
        .and_then(|b| {
            b.decide(
                user,
                org,
                &[],
                grant_org,
                &[
                    ("is_holder", Fact::Bool(is_holder)),
                    ("grant_live", Fact::Bool(grant_live)),
                ],
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_holder_of_a_live_grant_of_their_tenant_confirms() {
        assert!(decide("u", "o", "o", true, true));
        assert!(!decide("u", "o", "o", false, true));
        assert!(!decide("u", "o", "o", true, false));
        assert!(!decide("u", "o", "foreign", true, true));
        assert!(bundle().unwrap().decide("u", "o", &[], "o", &[]).is_err());
    }
}
