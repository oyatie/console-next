// SPDX-License-Identifier: LicenseRef-Proprietary
//! Every authenticated tenant account may read its tenant's count-free readiness.
use std::sync::OnceLock;

use console_kernel_core::OrgId;

use super::ActionBundle;
use crate::access::AccessSubject;

const SCHEMA: &str = r#"entity Subject = { org: String, roles: Set<String> };
entity Resource = { org: String };
action onboarding_modules_read appliesTo { principal: [Subject], resource: [Resource] };
"#;
const POLICIES: &str = r#"permit (principal, action == Action::"onboarding_modules_read", resource)
when { principal.org == resource.org };"#;

/// Facts come from `load_access_subject`; authentication is enforced at the REST boundary.
///
/// # Errors
/// Any Cedar compilation or evaluation diagnostic denies the read.
pub fn decide(subject: &AccessSubject, tenant: OrgId) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile("onboarding_modules_read", SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            &subject.account.to_string(),
            &subject.org.as_uuid().to_string(),
            &[],
            &tenant.as_uuid().to_string(),
            &[],
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::TenantPhase;

    #[test]
    fn no_grant_subject_can_only_read_its_own_tenant() {
        let subject = AccessSubject {
            org: OrgId::new(),
            account: uuid::Uuid::new_v4(),
            is_ops: false,
            phase: TenantPhase::Setup,
            grants: vec![],
        };
        assert_eq!(decide(&subject, subject.org), Ok(true));
        assert_eq!(decide(&subject, OrgId::new()), Ok(false));
    }
}
