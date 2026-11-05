// SPDX-License-Identifier: LicenseRef-Proprietary
//! Workspace admission for an account's own purchase-request preferences.

use console_kernel_core::Timestamp;

use super::super::action_schema::{ActionSchema, FactType, RequiredFact};
use super::super::facts::{FactValue, Facts};
use crate::{Feature, PermissionLevel, Principal};

pub const SCHEMA: ActionSchema = ActionSchema {
    denial_codes: &[
        "purchase_preferences_forbidden",
        "support_session_read_only",
    ],
    feature: Feature::PurchaseRequestRead,
    version: "2026-11-purchase-request-read-v1",
    facts: &[
        RequiredFact {
            name: "live_roles",
            ty: FactType::StringSet,
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
    policies: r#"@reason("support_session_read_only")
forbid(principal, action == Action::"purchase_request_read", resource)
when { context.is_support_session };
@reason("purchase_preferences_forbidden")
forbid(principal, action == Action::"purchase_request_read", resource)
when {
  !context.is_support_session &&
  !principal.is_tenant_ops && !context.has_feature_grant &&
  !context.live_roles.containsAny(["RECEPTIONIST", "MECHANIC", "ADMIN", "EXECUTIVE", "SUPER_ADMIN"])
};
permit(principal, action == Action::"purchase_request_read", resource)
when {
  principal.org == resource.org && !context.is_support_session &&
  (principal.is_tenant_ops || context.has_feature_grant ||
   context.live_roles.containsAny(["RECEPTIONIST", "MECHANIC", "ADMIN", "EXECUTIVE", "SUPER_ADMIN"]))
};
"#,
};

#[must_use]
pub fn decision_facts(principal: &Principal, live_roles: &[String], at: Timestamp) -> Facts {
    // Preferences belong to the caller, so any effective workspace read grant suffices.
    let readable = |feature: Feature, permission: PermissionLevel| {
        feature == Feature::PurchaseRequestRead && permission.satisfies(PermissionLevel::Limited)
    };
    let granted = principal
        .effective_feature_grants
        .iter()
        .any(|grant| readable(grant.feature, grant.permission))
        || principal
            .dated_feature_grants
            .iter()
            .filter_map(|grant| grant.resolve(at))
            .any(|grant| readable(grant.feature, grant.permission));
    Facts::new()
        .with(
            "live_roles",
            FactValue::StringSet(live_roles.iter().cloned().collect()),
        )
        .bool("has_feature_grant", granted)
        .bool("is_support_session", principal.support.is_some())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use crate::cedar_pbac::enforce::enforce_action;
    use crate::{AuthorizationResource, EffectiveFeatureGrant, SupportPrincipal};
    use console_kernel_core::{BranchScope, OrgId, UserId};

    #[test]
    fn workspace_grants_ops_support_and_tenant_boundaries() {
        let org = OrgId::new();
        let mut principal =
            Principal::new(UserId::new(), org, Default::default(), BranchScope::All);
        let decide = |principal: &Principal, target| {
            enforce_action(
                principal,
                Feature::PurchaseRequestRead,
                AuthorizationResource::org_wide(target, "purchase_preferences"),
                &decision_facts(principal, &[], Timestamp::now_utc()),
            )
        };
        assert_eq!(
            decide(&principal, org).unwrap_err().code,
            Some("purchase_preferences_forbidden")
        );
        for permission in [
            PermissionLevel::Deny,
            PermissionLevel::RequestOnly,
            PermissionLevel::Limited,
            PermissionLevel::Allow,
        ] {
            principal.effective_feature_grants = vec![EffectiveFeatureGrant::new(
                Feature::PurchaseRequestRead,
                permission,
                BranchScope::All,
            )];
            assert_eq!(
                decide(&principal, org).is_ok(),
                matches!(
                    permission,
                    PermissionLevel::Limited | PermissionLevel::Allow
                )
            );
        }
        assert!(decide(&principal, OrgId::new()).is_err());
        principal.effective_feature_grants.clear();
        principal.is_tenant_ops = true;
        assert!(decide(&principal, org).is_ok());
        principal.support = Some(SupportPrincipal {
            active: true,
            org_id: *org.as_uuid(),
            operator_approved: true,
            tenant_approved: true,
            session_id: uuid::Uuid::new_v4(),
            operator_label: "operator".to_owned(),
            scope: Vec::new(),
            reveal_classes: Vec::new(),
        });
        assert_eq!(
            decide(&principal, org).unwrap_err().code,
            Some("support_session_read_only")
        );
    }

    #[test]
    fn dated_workspace_grants_expire_at_the_exclusive_end() {
        use crate::{DatedFeatureGrant, GrantValidity};

        let org = OrgId::new();
        let at = Timestamp::now_utc();
        let mut principal =
            Principal::new(UserId::new(), org, Default::default(), BranchScope::All);
        principal.dated_feature_grants = vec![DatedFeatureGrant::new(
            EffectiveFeatureGrant::new(
                Feature::PurchaseRequestRead,
                PermissionLevel::Limited,
                BranchScope::All,
            ),
            GrantValidity::half_open(at, Some(at + time::Duration::hours(1))).unwrap(),
        )];
        for (instant, allowed) in [
            (at - time::Duration::seconds(1), false),
            (at, true),
            (at + time::Duration::hours(1), false),
        ] {
            assert_eq!(
                enforce_action(
                    &principal,
                    Feature::PurchaseRequestRead,
                    AuthorizationResource::org_wide(org, "purchase_preferences"),
                    &decision_facts(&principal, &[], instant),
                )
                .is_ok(),
                allowed
            );
        }
    }
}
