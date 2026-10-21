//! Tenant ops can ask the platform operator to change their own company's domain.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;
const ACTION: &str = "company_domain_request";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action company_domain_request appliesTo { principal: [Subject], resource: [Resource],
    context: { "tenant_ops": Bool, "target_org": String } };
"#;
const POLICIES: &str = r#"permit(principal, action == Action::"company_domain_request", resource)
when { context.tenant_ops && principal.org == context.target_org && principal.org == resource.org };
"#;

pub fn decide(user: &str, org: &str, target_org: &str, tenant_ops: bool) -> bool {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .ok()
        .and_then(|bundle| {
            bundle
                .decide(
                    user,
                    org,
                    &[],
                    org,
                    &[
                        ("tenant_ops", Fact::Bool(tenant_ops)),
                        ("target_org", Fact::Str(target_org.into())),
                    ],
                )
                .ok()
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::decide;
    #[test]
    fn only_ops_of_the_target_tenant_can_request() {
        assert!(decide("user", "tenant", "tenant", true));
        assert!(!decide("user", "tenant", "another", true));
        assert!(!decide("user", "tenant", "tenant", false));
    }
}
