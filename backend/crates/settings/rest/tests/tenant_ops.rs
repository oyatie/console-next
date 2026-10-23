// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::access::{NodeKind, ScopeGrant};
use console_platform_authz::{Feature, Principal};
use console_settings_application::ChangeFacts;
use console_settings_domain::code_lists::ReasonDomain;
use console_settings_domain::{Direction, SettingKey};
use console_settings_rest::authz::{authorize_change, authorize_manage};
use uuid::Uuid;

#[test]
fn ops_policy_overrides_scope_grants_but_keeps_step_up_and_closed_domains() {
    let principal = Principal::new(
        UserId::new(),
        OrgId::new(),
        Default::default(),
        BranchScope::All,
    )
    .with_tenant_ops(true)
    .with_scope_grants(vec![
        ScopeGrant {
            feature: Feature::SettingsManage,
            kind: NodeKind::LegalEntity,
            id: Uuid::new_v4(),
        },
        ScopeGrant {
            feature: Feature::ReasonCodeManage,
            kind: NodeKind::LegalEntity,
            id: Uuid::new_v4(),
        },
    ]);
    for scope_entity_id in [None, Some(Uuid::new_v4())] {
        let mut facts = ChangeFacts {
            key: SettingKey::ALL[0],
            scope_entity_id,
            direction: Direction::Tighten,
            step_up: false,
            step_up_assertion_id: None,
        };
        assert!(authorize_change(&principal, &facts).is_ok());
        facts.direction = Direction::Loosen;
        assert_eq!(
            authorize_change(&principal, &facts).unwrap_err().code,
            Some("step_up_required")
        );
        facts.step_up = true;
        assert!(authorize_change(&principal, &facts).is_ok());
    }
    assert!(authorize_manage(&principal, Some(ReasonDomain::OrgChangeReason)).is_ok());
    assert_eq!(
        authorize_manage(&principal, Some(ReasonDomain::Exception))
            .unwrap_err()
            .code,
        Some("reason_domain_closed")
    );
}
