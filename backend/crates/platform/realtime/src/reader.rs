// SPDX-License-Identifier: LicenseRef-Proprietary
//! A stream retains the authenticated tier; platform authority never becomes tenant grants.
use crate::filter::{ChangeRow, may_read};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{PlatformFeature, PlatformPrincipal, Principal};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeReader {
    Tenant(Box<Principal>),
    Platform(PlatformPrincipal),
}
impl From<Principal> for ChangeReader {
    fn from(value: Principal) -> Self {
        Self::Tenant(Box::new(value))
    }
}
impl ChangeReader {
    pub(crate) fn user_id(&self) -> UserId {
        match self {
            Self::Tenant(p) => p.user_id,
            Self::Platform(p) => p.user_id,
        }
    }
    pub(crate) fn org_id(&self) -> OrgId {
        match self {
            Self::Tenant(p) => p.org_id,
            Self::Platform(_) => OrgId::platform(),
        }
    }
    pub(crate) fn branch_scope(&self) -> BranchScope {
        match self {
            Self::Tenant(p) => p.branch_scope.clone(),
            Self::Platform(_) => BranchScope::Branches(Default::default()),
        }
    }
    pub(crate) fn may_read(&self, row: &ChangeRow) -> bool {
        match self {
            Self::Tenant(p) => {
                matches!(
                    row.resource_type.as_str(),
                    "ops_recovery" | "support_session"
                ) || may_read(p, row)
            }
            Self::Platform(p) => {
                row.resource_type == "ops_recovery"
                    && p.authorize(PlatformFeature::TenantCreate).is_ok()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tenant_without_roles_receives_recovery_hints_only() {
        let reader = ChangeReader::from(Principal::new(
            UserId::new(),
            OrgId::one(),
            Default::default(),
            BranchScope::All,
        ));
        for (kind, allowed) in [("ops_recovery", true), ("employee", false)] {
            let row = ChangeRow {
                seq: 1,
                resource_type: kind.into(),
                resource_id: None,
                branch_id: None,
                ver: None,
            };
            assert_eq!(reader.may_read(&row), allowed, "{kind}");
        }
    }

    #[test]
    fn platform_stream_has_only_recovery_hints() {
        let reader = ChangeReader::Platform(PlatformPrincipal::new(UserId::new()));
        for (kind, allowed) in [
            ("ops_recovery", true),
            ("employee", false),
            ("tenant", false),
            ("unknown", false),
        ] {
            let row = ChangeRow {
                seq: 1,
                resource_type: kind.into(),
                resource_id: None,
                branch_id: None,
                ver: None,
            };
            assert_eq!(reader.may_read(&row), allowed);
        }
    }
}
