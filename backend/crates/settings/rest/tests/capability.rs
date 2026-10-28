// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::access::{NodeKind, ScopeGrant};
use console_platform_authz::{Feature, Principal};
use console_settings_rest::authz::can_change;
use uuid::Uuid;

#[test]
fn capability_uses_requested_scope_without_a_registry_entry_or_step_up() {
    let (entity, workplace, other) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let principal = Principal::new(
        UserId::new(),
        OrgId::new(),
        Default::default(),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::SettingsManage,
        kind: NodeKind::LegalEntity,
        id: entity,
    }]);
    assert!(can_change(&principal, &[workplace, entity]));
    assert!(!can_change(&principal, &[other]));
    assert!(!can_change(&principal, &[]));
    let tenant = principal.clone().with_scope_grants(vec![ScopeGrant {
        feature: Feature::SettingsManage,
        kind: NodeKind::Tenant,
        id: *principal.org_id.as_uuid(),
    }]);
    assert!(can_change(&tenant, &[]));
    assert!(can_change(&tenant, &[workplace, entity]));
}
