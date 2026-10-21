//! Platform listings use verified live authority inside the listing transaction.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action platform_listing appliesTo { principal: [Subject], resource: [Resource],
  context: { "platform": Bool, "operation": String }
};"#;
const POLICIES: &str = r#"permit (principal, action == Action::"platform_listing", resource)
when { principal.org == resource.org && principal.roles.contains("SUPER_ADMIN")
  && context.platform && ["groups", "tenants", "health"].contains(context.operation) };"#;

pub fn decide(user: &str, org: &str, roles: &[&str], platform: bool, operation: &str) -> bool {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile("platform_listing", SCHEMA, POLICIES))
        .as_ref()
        .ok()
        .and_then(|bundle| {
            bundle
                .decide(
                    user,
                    org,
                    roles,
                    org,
                    &[
                        ("platform", Fact::Bool(platform)),
                        ("operation", Fact::Str(operation.into())),
                    ],
                )
                .ok()
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_current_platform_operators_may_list() {
        for operation in ["groups", "tenants", "health"] {
            assert!(decide("u", "o", &["SUPER_ADMIN"], true, operation));
            assert!(!decide("u", "o", &["ADMIN"], true, operation));
            assert!(!decide("u", "o", &[], true, operation));
            assert!(!decide("u", "o", &["SUPER_ADMIN"], false, operation));
        }
        assert!(!decide("u", "o", &["SUPER_ADMIN"], true, "unknown"));
        let bundle = ActionBundle::compile("platform_listing", SCHEMA, POLICIES).unwrap();
        assert!(bundle.decide("u", "o", &["SUPER_ADMIN"], "o", &[]).is_err());
        assert_eq!(
            bundle.decide(
                "u",
                "o",
                &["SUPER_ADMIN"],
                "foreign",
                &[
                    ("platform", Fact::Bool(true)),
                    ("operation", Fact::Str("groups".into()))
                ]
            ),
            Ok(false)
        );
    }
}
