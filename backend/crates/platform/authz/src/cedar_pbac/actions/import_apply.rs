// SPDX-License-Identifier: LicenseRef-Proprietary
//! Import admission retains the existing operations role and tenant-wide HR grant.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "import_apply";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action import_apply appliesTo { principal: [Subject], resource: [Resource],
 context: { "manages_directory": Bool } };"#;
const POLICIES: &str = r#"permit(principal, action == Action::"import_apply", resource)
when { principal.org == resource.org &&
 (principal.roles.contains("SUPER_ADMIN") || context.manages_directory) };"#;

pub async fn require(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: console_kernel_core::OrgId,
    actor: uuid::Uuid,
) -> Result<(), console_kernel_core::KernelError> {
    use crate::{
        Feature,
        access::{NodeKind, NodeRef},
    };
    use console_kernel_core::KernelError;
    let facts = super::super::visible::load_facts(tx, org, actor).await?;
    let target = NodeRef {
        kind: NodeKind::Tenant,
        id: *org.as_uuid(),
    };
    let manages = facts
        .authorize(Feature::EmployeeDirectoryManage.as_str(), target)
        .map_err(|error| KernelError::internal(error.to_string()))?;
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    let org = org.to_string();
    let context = [("manages_directory", Fact::Bool(manages))];
    let roles: Vec<_> = facts.roles().iter().map(String::as_str).collect();
    let allowed = BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(|error| KernelError::internal(error.clone()))?
        .decide(&actor.to_string(), &org, &roles, &org, &context)
        .map_err(KernelError::internal)?;
    if allowed {
        Ok(())
    } else {
        Err(KernelError::forbidden(
            "employee import requires tenant-wide directory management",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tenant_wide_grant_or_operations_role_is_required() {
        let bundle = ActionBundle::compile(ACTION, SCHEMA, POLICIES).unwrap();
        for (roles, manages, allowed) in [
            (["SUPER_ADMIN"], false, true),
            (["MEMBER"], true, true),
            (["MEMBER"], false, false),
            (["ADMIN"], false, false),
        ] {
            assert_eq!(
                bundle.decide(
                    "u",
                    "o",
                    &roles,
                    "o",
                    &[("manages_directory", Fact::Bool(manages))]
                ),
                Ok(allowed)
            );
            assert_eq!(
                bundle.decide(
                    "u",
                    "o",
                    &roles,
                    "other",
                    &[("manages_directory", Fact::Bool(manages))]
                ),
                Ok(false)
            );
        }
        assert!(
            ActionBundle::compile(ACTION, SCHEMA, POLICIES)
                .unwrap()
                .decide("u", "o", &[], "o", &[])
                .is_err()
        );
    }
}
