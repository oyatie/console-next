// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use std::collections::BTreeSet;

use console_kernel_core::{BranchScope, ErrorKind, OrgId, UserId};
use console_platform_authz::access::{NodeKind, ScopeGrant};
use console_platform_authz::{Feature, Principal, Role};
use console_settings_application::ChangeFacts;
use console_settings_domain::Direction;
use console_settings_domain::SettingKey;
use console_settings_rest::authorize_history;
use console_settings_rest::authz::{authorize_change, authorize_manage};
use uuid::Uuid;

/// A plain member loosening without step-up is refused through the Cedar
/// call, whether or not the schemas are enrolled yet (fail closed).
#[test]
fn a_member_is_refused_on_every_swapped_route() {
    let member = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    );
    let change = ChangeFacts {
        key: SettingKey::ALL[0],
        scope_entity_id: None,
        direction: Direction::Loosen,
        step_up: false,
        step_up_assertion_id: None,
    };
    let domain = console_settings_domain::code_lists::ReasonDomain::ALL[0];
    for got in [
        authorize_change(&member, &change),
        authorize_history(&member),
        authorize_manage(&member, Some(domain)),
        authorize_manage(&member, None),
    ] {
        assert_eq!(got.unwrap_err().kind, ErrorKind::Forbidden);
    }
}

#[test]
fn an_admin_with_grant_is_permitted_for_settings_and_reason_codes() {
    let admin = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
    .with_scope_grants(vec![
        ScopeGrant {
            feature: Feature::SettingsManage,
            kind: NodeKind::Tenant,
            id: *OrgId::one().as_uuid(),
        },
        ScopeGrant {
            feature: Feature::ReasonCodeManage,
            kind: NodeKind::Tenant,
            id: *OrgId::one().as_uuid(),
        },
    ]);
    let tighten = ChangeFacts {
        key: SettingKey::ALL[0],
        scope_entity_id: None,
        direction: Direction::Tighten,
        step_up: false,
        step_up_assertion_id: None,
    };
    let domain = console_settings_domain::code_lists::ReasonDomain::OrgChangeReason;
    assert!(authorize_change(&admin, &tighten).is_ok());
    assert!(authorize_manage(&admin, Some(domain)).is_ok());
}

#[test]
fn loosening_without_step_up_returns_step_up_required() {
    let admin = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::SettingsManage,
        kind: NodeKind::Tenant,
        id: *OrgId::one().as_uuid(),
    }]);
    let loosen = ChangeFacts {
        key: SettingKey::ALL[0],
        scope_entity_id: None,
        direction: Direction::Loosen,
        step_up: false,
        step_up_assertion_id: None,
    };
    let err = authorize_change(&admin, &loosen).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
    assert_eq!(err.code, Some("step_up_required"));
}

#[test]
fn moving_the_org_apply_clock_later_is_authorized_without_step_up() {
    let org = OrgId::one();
    let admin = Principal::new(
        UserId::new(),
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::SettingsManage,
        kind: NodeKind::Tenant,
        id: *org.as_uuid(),
    }]);
    let key: SettingKey = "orgchange.apply_time".parse().unwrap();
    let value = console_settings_domain::SettingValue::Int;
    let change = ChangeFacts {
        key,
        direction: console_settings_domain::direction(key, Some(value(5)), value(60)),
        scope_entity_id: None,
        step_up: false,
        step_up_assertion_id: None,
    };
    assert!(authorize_change(&admin, &change).is_ok());
}

#[test]
fn unverified_step_up_returns_step_up_required() {
    let admin = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::SettingsManage,
        kind: NodeKind::Tenant,
        id: *OrgId::one().as_uuid(),
    }]);
    let loosen = ChangeFacts {
        key: SettingKey::ALL[0],
        scope_entity_id: None,
        direction: Direction::Loosen,
        step_up: false,
        step_up_assertion_id: Some(Uuid::new_v4()),
    };
    let err = authorize_change(&admin, &loosen).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
    assert_eq!(err.code, Some("step_up_required"));
}

#[test]
fn verified_step_up_is_permitted_for_loosening() {
    let admin = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::SettingsManage,
        kind: NodeKind::Tenant,
        id: *OrgId::one().as_uuid(),
    }]);
    let loosen = ChangeFacts {
        key: SettingKey::ALL[0],
        scope_entity_id: None,
        direction: Direction::Loosen,
        step_up: true,
        step_up_assertion_id: Some(Uuid::new_v4()),
    };
    assert!(authorize_change(&admin, &loosen).is_ok());
}

#[test]
fn scoped_grant_writing_tenant_wide_returns_scope_tenant_wide_only() {
    let entity_id = Uuid::new_v4();
    let user = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::SettingsManage,
        kind: NodeKind::LegalEntity,
        id: entity_id,
    }]);

    let tenant_wide = ChangeFacts {
        key: SettingKey::ALL[0],
        scope_entity_id: None,
        direction: Direction::Tighten,
        step_up: false,
        step_up_assertion_id: None,
    };
    let err = authorize_change(&user, &tenant_wide).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
    assert_eq!(err.code, Some("scope_tenant_wide_only"));
}

#[test]
fn scoped_grant_writing_other_entity_returns_out_of_scope() {
    let entity_a = Uuid::new_v4();
    let entity_b = Uuid::new_v4();
    let user = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::SettingsManage,
        kind: NodeKind::LegalEntity,
        id: entity_a,
    }]);

    let write_b = ChangeFacts {
        key: SettingKey::ALL[0],
        scope_entity_id: Some(entity_b),
        direction: Direction::Tighten,
        step_up: false,
        step_up_assertion_id: None,
    };
    let err = authorize_change(&user, &write_b).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
    assert_eq!(err.code, Some("out_of_scope"));
}

#[test]
fn scoped_grant_writing_matching_entity_is_permitted() {
    let entity_a = Uuid::new_v4();
    let user = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::SettingsManage,
        kind: NodeKind::LegalEntity,
        id: entity_a,
    }]);

    let write_a = ChangeFacts {
        key: SettingKey::ALL[0],
        scope_entity_id: Some(entity_a),
        direction: Direction::Tighten,
        step_up: false,
        step_up_assertion_id: None,
    };
    assert!(authorize_change(&user, &write_a).is_ok());
}

#[test]
fn closed_reason_domain_returns_reason_domain_closed() {
    let admin = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::ReasonCodeManage,
        kind: NodeKind::Tenant,
        id: *OrgId::one().as_uuid(),
    }]);
    let closed = console_settings_domain::code_lists::ReasonDomain::Exception;
    assert!(!closed.tenant_extensible());
    let err = authorize_manage(&admin, Some(closed)).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
    assert_eq!(err.code, Some("reason_domain_closed"));
}

#[test]
fn scoped_grant_for_reason_codes_writing_without_tenant_wide_returns_scope_tenant_wide_only() {
    let entity_id = Uuid::new_v4();
    let user = Principal::new(
        UserId::new(),
        OrgId::one(),
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::ReasonCodeManage,
        kind: NodeKind::LegalEntity,
        id: entity_id,
    }]);

    let open = console_settings_domain::code_lists::ReasonDomain::OrgChangeReason;
    let err = authorize_manage(&user, Some(open)).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
    assert_eq!(err.code, Some("scope_tenant_wide_only"));
}
