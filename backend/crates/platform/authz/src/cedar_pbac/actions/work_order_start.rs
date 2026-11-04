// SPDX-License-Identifier: LicenseRef-Proprietary
//! `work_order_start`: Cedar admission for mobile work-order sync batches.
//!
//! Mobile offline sync replays field work-order mutations (`WORK_ORDER_START`
//! and `WORK_ORDER_REPORT`). Admission requires an active tenant caller in the
//! target organization who holds field-execution authority (`MECHANIC`, `ADMIN`,
//! `SUPER_ADMIN`, tenant ops, or an active custom feature grant), and refuses
//! read-only support sessions before any sync request row is claimed.

use std::collections::BTreeSet;

use console_kernel_core::Timestamp;

use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::{FactValue, Facts};
use crate::{Feature, PermissionLevel, Principal};

pub const LIVE_ROLES: RequiredFact = RequiredFact {
    name: "live_roles",
    ty: FactType::StringSet,
};

pub const HAS_FEATURE_GRANT: RequiredFact = RequiredFact {
    name: "has_feature_grant",
    ty: FactType::Bool,
};

pub const IS_SUPPORT_SESSION: RequiredFact = RequiredFact {
    name: "is_support_session",
    ty: FactType::Bool,
};

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &["mobile_sync_forbidden", "support_session_read_only"],
    feature: Feature::WorkOrderStart,
    version: "2026-11-work-order-start-v1",
    facts: &[LIVE_ROLES, HAS_FEATURE_GRANT, IS_SUPPORT_SESSION],
    policies: r#"@reason("support_session_read_only")
forbid(principal, action == Action::"work_order_start", resource)
when {
  context.is_support_session
};
@reason("mobile_sync_forbidden")
forbid(principal, action == Action::"work_order_start", resource)
when {
  !context.is_support_session &&
  !principal.is_tenant_ops &&
  !context.has_feature_grant &&
  !context.live_roles.contains("MECHANIC") &&
  !context.live_roles.contains("ADMIN") &&
  !context.live_roles.contains("SUPER_ADMIN")
};
permit(principal, action == Action::"work_order_start", resource)
when {
  principal.org == resource.org &&
  !context.is_support_session &&
  (principal.is_tenant_ops ||
   context.has_feature_grant ||
   context.live_roles.contains("MECHANIC") ||
   context.live_roles.contains("ADMIN") ||
   context.live_roles.contains("SUPER_ADMIN"))
};
"#,
};

/// Build the required Cedar context facts from the caller principal and live
/// tenant role snapshot loaded inside the decision transaction.
#[must_use]
pub fn decision_facts(principal: &Principal, live_roles: &[String], at: Timestamp) -> Facts {
    let roles: BTreeSet<String> = live_roles.iter().cloned().collect();
    let allows_sync = |feature: Feature, permission: PermissionLevel| {
        matches!(feature, Feature::WorkOrderStart | Feature::WorkReportSubmit)
            && permission.satisfies(PermissionLevel::Allow)
    };
    let has_grant = principal
        .effective_feature_grants
        .iter()
        .any(|grant| allows_sync(grant.feature, grant.permission))
        || principal
            .dated_feature_grants
            .iter()
            .filter_map(|dated| dated.resolve(at))
            .any(|grant| allows_sync(grant.feature, grant.permission));
    Facts::new()
        .with(LIVE_ROLES.name, FactValue::StringSet(roles))
        .bool(HAS_FEATURE_GRANT.name, has_grant)
        .bool(IS_SUPPORT_SESSION.name, principal.support.is_some())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use console_kernel_core::{BranchScope, ErrorKind, OrgId, Timestamp, UserId};

    use super::decision_facts;
    use crate::cedar_pbac::enforce::enforce_action;
    use crate::{
        AuthorizationResource, EffectiveFeatureGrant, Feature, PermissionLevel, Principal,
        SupportPrincipal,
    };

    fn support_session(org: OrgId) -> SupportPrincipal {
        SupportPrincipal {
            active: true,
            org_id: *org.as_uuid(),
            operator_approved: true,
            tenant_approved: true,
            session_id: uuid::Uuid::new_v4(),
            operator_label: "operator".to_owned(),
            scope: Vec::new(),
            reveal_classes: Vec::new(),
        }
    }

    #[test]
    fn field_roles_custom_grant_and_tenant_ops_are_permitted() {
        let org = OrgId::new();
        let now = Timestamp::now_utc();
        for role in ["MECHANIC", "ADMIN", "SUPER_ADMIN"] {
            let principal =
                Principal::new(UserId::new(), org, Default::default(), BranchScope::All);
            let facts = decision_facts(&principal, &[role.to_owned()], now);
            assert!(
                enforce_action(
                    &principal,
                    Feature::WorkOrderStart,
                    AuthorizationResource::org_wide(org, "mobile_sync"),
                    &facts,
                )
                .is_ok(),
                "{role} should be permitted"
            );
        }

        let granted = Principal::new(UserId::new(), org, Default::default(), BranchScope::All)
            .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                Feature::WorkOrderStart,
                PermissionLevel::Allow,
                BranchScope::All,
            )]);
        let grant_facts = decision_facts(&granted, &["MEMBER".to_owned()], now);
        assert!(
            enforce_action(
                &granted,
                Feature::WorkOrderStart,
                AuthorizationResource::org_wide(org, "mobile_sync"),
                &grant_facts,
            )
            .is_ok()
        );

        let ops = Principal::new(UserId::new(), org, Default::default(), BranchScope::All)
            .with_tenant_ops(true);
        let ops_facts = decision_facts(&ops, &[], now);
        assert!(
            enforce_action(
                &ops,
                Feature::WorkOrderStart,
                AuthorizationResource::org_wide(org, "mobile_sync"),
                &ops_facts,
            )
            .is_ok()
        );
    }

    #[test]
    fn non_field_roles_and_support_sessions_receive_coded_refusals() {
        let org = OrgId::new();
        let now = Timestamp::now_utc();
        for roles in [
            vec![],
            vec!["MEMBER".to_owned()],
            vec!["RECEPTIONIST".to_owned()],
            vec!["EXECUTIVE".to_owned()],
        ] {
            let principal =
                Principal::new(UserId::new(), org, Default::default(), BranchScope::All);
            let facts = decision_facts(&principal, &roles, now);
            let err = enforce_action(
                &principal,
                Feature::WorkOrderStart,
                AuthorizationResource::org_wide(org, "mobile_sync"),
                &facts,
            )
            .unwrap_err();
            assert_eq!(err.kind, ErrorKind::Forbidden);
            assert_eq!(err.code, Some("mobile_sync_forbidden"));
        }

        let mut support = Principal::new(UserId::new(), org, Default::default(), BranchScope::All)
            .with_tenant_ops(true);
        support.support = Some(support_session(org));
        let support_facts = decision_facts(&support, &["SUPER_ADMIN".to_owned()], now);
        let err = enforce_action(
            &support,
            Feature::WorkOrderStart,
            AuthorizationResource::org_wide(org, "mobile_sync"),
            &support_facts,
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Forbidden);
        assert_eq!(err.code, Some("support_session_read_only"));
    }

    #[test]
    fn cross_tenant_resource_is_refused() {
        let org = OrgId::new();
        let other = OrgId::new();
        let principal = Principal::new(UserId::new(), org, Default::default(), BranchScope::All)
            .with_tenant_ops(true);
        let facts = decision_facts(
            &principal,
            &["SUPER_ADMIN".to_owned()],
            Timestamp::now_utc(),
        );
        let err = enforce_action(
            &principal,
            Feature::WorkOrderStart,
            AuthorizationResource::org_wide(other, "mobile_sync"),
            &facts,
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Forbidden);
    }
}
