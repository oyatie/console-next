// SPDX-License-Identifier: LicenseRef-Proprietary
//! Cedar admission for branch-filtered tenant audit log reads (`GET /api/audit`).

use console_kernel_core::Timestamp;

use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::Facts;
use crate::{Feature, PermissionLevel, Principal};

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[],
    feature: Feature::AuditLogRead,
    version: "2026-11-audit-log-read-v1",
    facts: &[
        RequiredFact {
            name: "has_branch_scope",
            ty: FactType::Bool,
        },
        RequiredFact {
            name: "has_feature_grant",
            ty: FactType::Bool,
        },
        RequiredFact {
            name: "is_support_session",
            ty: FactType::Bool,
        },
    ],
    policies: r#"forbid(principal, action == Action::"audit_log_read", resource)
when { context.is_support_session || !context.has_branch_scope };
permit(principal, action == Action::"audit_log_read", resource)
when {
  principal.org == resource.org &&
  !context.is_support_session &&
  context.has_branch_scope &&
  (principal.roles.containsAny(["ADMIN", "SUPER_ADMIN"]) || context.has_feature_grant)
};
"#,
};

#[must_use]
pub fn decision_facts(principal: &Principal, at: Timestamp) -> Facts {
    let has_scope = crate::decide::has_branch_scope(principal);
    let granted = crate::decide::has_covering_feature_grant(
        principal,
        Feature::AuditLogRead,
        PermissionLevel::Allow,
        Some(at),
    );
    Facts::new()
        .bool("has_branch_scope", has_scope)
        .bool("has_feature_grant", granted)
        .bool("is_support_session", principal.support.is_some())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::collections::BTreeSet;

    use console_kernel_core::{BranchId, BranchScope, OrgId, Timestamp, UserId};

    use super::*;
    use crate::cedar_pbac::enforce::enforce_action;
    use crate::{
        AuthorizationResource, DatedFeatureGrant, EffectiveFeatureGrant, GrantValidity, Role,
        SupportPrincipal,
    };

    fn eval(principal: &Principal, target_org: OrgId, at: Timestamp) -> bool {
        enforce_action(
            principal,
            Feature::AuditLogRead,
            AuthorizationResource::branchless(target_org, "audit_log"),
            &decision_facts(principal, at),
        )
        .is_ok()
    }

    #[test]
    fn roles_empty_scope_and_support_session_follow_audit_read_policy() {
        let org = OrgId::new();
        let now = Timestamp::now_utc();
        let branch = BranchId::new();
        let admin = Principal::new(
            UserId::new(),
            org,
            BTreeSet::from([Role::Admin]),
            BranchScope::single(branch),
        );
        assert!(eval(&admin, org, now));
        assert!(!eval(&admin, OrgId::new(), now), "cross-org must deny");

        let super_admin = Principal::new(
            UserId::new(),
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        assert!(eval(&super_admin, org, now));

        let empty_scope = Principal::new(
            UserId::new(),
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::none(),
        )
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::AuditLogRead,
            PermissionLevel::Allow,
            BranchScope::All,
        )]);
        assert!(!eval(&empty_scope, org, now), "empty scope must deny");

        for role in [
            Role::Member,
            Role::Mechanic,
            Role::Receptionist,
            Role::Executive,
        ] {
            let p = Principal::new(UserId::new(), org, BTreeSet::from([role]), BranchScope::All);
            assert!(!eval(&p, org, now), "{role:?} without grant must deny");
        }

        let mut support = admin;
        support.support = Some(SupportPrincipal {
            active: true,
            org_id: *org.as_uuid(),
            operator_approved: true,
            tenant_approved: true,
            session_id: uuid::Uuid::new_v4(),
            operator_label: "operator".to_owned(),
            scope: vec!["audit".to_owned()],
            reveal_classes: Vec::new(),
        });
        assert!(!eval(&support, org, now), "support session must deny");
    }

    #[test]
    fn custom_grants_honor_permission_level_covering_scope_and_validity() {
        let org = OrgId::new();
        let now = Timestamp::now_utc();
        let branch_a = BranchId::new();
        let branch_b = BranchId::new();
        let multi = BranchScope::Branches(BTreeSet::from([branch_a, branch_b]));

        for permission in [
            PermissionLevel::Deny,
            PermissionLevel::RequestOnly,
            PermissionLevel::Limited,
            PermissionLevel::Allow,
        ] {
            let member = Principal::new(
                UserId::new(),
                org,
                BTreeSet::from([Role::Member]),
                BranchScope::All,
            )
            .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                Feature::AuditLogRead,
                permission,
                BranchScope::All,
            )]);
            assert_eq!(
                eval(&member, org, now),
                permission == PermissionLevel::Allow
            );
        }

        let narrower = Principal::new(
            UserId::new(),
            org,
            BTreeSet::from([Role::Member]),
            multi.clone(),
        )
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::AuditLogRead,
            PermissionLevel::Allow,
            BranchScope::single(branch_a),
        )]);
        assert!(
            !eval(&narrower, org, now),
            "grant narrower than principal branch scope must deny"
        );

        let covered = Principal::new(
            UserId::new(),
            org,
            BTreeSet::from([Role::Member]),
            BranchScope::single(branch_a),
        )
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::AuditLogRead,
            PermissionLevel::Allow,
            multi,
        )]);
        assert!(eval(&covered, org, now));

        let dated = Principal::new(
            UserId::new(),
            org,
            BTreeSet::from([Role::Member]),
            BranchScope::single(branch_a),
        )
        .with_dated_feature_grants(vec![DatedFeatureGrant::new(
            EffectiveFeatureGrant::new(
                Feature::AuditLogRead,
                PermissionLevel::Allow,
                BranchScope::single(branch_a),
            ),
            GrantValidity::half_open(now, Some(now + time::Duration::hours(1))).unwrap(),
        )]);
        assert!(!eval(&dated, org, now - time::Duration::seconds(1)));
        assert!(eval(&dated, org, now));
        assert!(!eval(&dated, org, now + time::Duration::hours(1)));
    }
}
