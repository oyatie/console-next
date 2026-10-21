//! Branch-scoped authorization policy engine.
//!
//! The policy has two independent gates:
//! 1. feature permission from the inherited role matrix;
//! 2. resource `branch_id` membership from the kernel [`BranchScope`].
//!
//! Both gates default-deny. Repository adapters should use [`repository_filter`]
//! when listing branch-scoped rows so missing scope checks are difficult to
//! express accidentally.
//!
//! [`BranchScope`]: console_kernel_core::BranchScope
//! [`repository_filter`]: fn@repository_filter
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod access;
mod action;
pub mod cedar_pbac;
mod cedar_stack;
mod decide;
mod feature;
mod grants;
mod grants_sql;
mod permission;
mod platform;
mod principal;
mod repository_filter;
mod resource_branch;
mod role;
mod scope;
mod temporal;

pub use resource_branch::{BranchScopedResource, ResourceBranch};
pub use temporal::{GrantValidity, enforce_assignment_non_overlap};

pub use action::*;
pub use decide::*;
pub use feature::*;
pub use grants::*;
pub use grants_sql::*;
pub use permission::*;
pub use platform::*;
pub use principal::*;
pub use repository_filter::*;
pub use role::*;
pub use scope::*;

pub use cedar_pbac::{
    AuthorizationAuditEvent, AuthorizationContext, AuthorizationDecision,
    AuthorizationMetricLabels, AuthorizationRequest, AuthorizationResource, AuthorizationSubject,
    CedarEvaluation, CoexistenceMapEntry, CompiledBundleCacheKey, DecisionEffect, DecisionEngine,
    DecisionReason, DualEngineMode, RlsScopeProof, RlsScopeProofSource, SubjectFreshness,
    SubjectFreshnessRequirement, evaluate_cedar_pbac_boundary, evaluate_legacy_contract,
    observe_cedar_pbac_decision,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use console_kernel_core::{
        AccessScope, AccessScopeLevel, BranchId, BranchScope, ErrorKind, KernelError, OrgId,
        ScopeNodeId, ServicePrincipalId, Timestamp, UserId,
    };

    #[test]
    fn attendance_management_features_are_admin_and_super_admin_only() {
        let cases = [
            (
                Feature::AttendanceExceptionManage,
                "attendance_exception_manage",
            ),
            (
                Feature::AttendanceSubstitutionManage,
                "attendance_substitution_manage",
            ),
        ];

        for (feature, code) in cases {
            assert!(Feature::ALL.contains(&feature));
            assert_eq!(feature.as_str(), code);
            assert_eq!(code.parse::<Feature>().unwrap(), feature);
            assert_eq!(
                serde_json::to_string(&feature).unwrap(),
                format!("\"{code}\"")
            );
            assert_eq!(
                serde_json::from_str::<Feature>(&format!("\"{code}\"")).unwrap(),
                feature
            );

            for role in Role::ALL {
                let expected = match role {
                    Role::Admin | Role::SuperAdmin => PermissionLevel::Allow,
                    Role::Member | Role::Receptionist | Role::Mechanic | Role::Executive => {
                        PermissionLevel::Deny
                    }
                };
                assert_eq!(
                    permission_for(role, feature),
                    expected,
                    "{role:?} on {feature:?}"
                );
            }
        }
    }

    #[test]
    fn service_authorization_requires_exact_feature_and_branch() {
        let branch = BranchId::new();
        let service = ServicePrincipal::new(
            ServicePrincipalId::new(),
            OrgId::new(),
            branch,
            Feature::ProductionSourceIngest,
        );
        assert!(
            authorize_service(
                &service,
                Action::limited(Feature::ProductionSourceIngest),
                branch,
            )
            .is_ok()
        );
        assert!(
            authorize_service(
                &service,
                Action::limited(Feature::ProductionSourceIngest),
                BranchId::new(),
            )
            .is_err()
        );
        assert!(
            authorize_service(&service, Action::limited(Feature::DailyPlanRequest), branch,)
                .is_err()
        );
    }

    #[test]
    fn effective_scope_preserves_legacy_org_live_scope() -> Result<(), KernelError> {
        let org = OrgId::new();
        let branch = BranchId::new();
        let live_scope = BranchScope::single(branch);

        let effective =
            effective_branch_scope_for_tenant(live_scope, AccessScope::legacy_org(org), org)?;

        assert_eq!(effective, BranchScope::single(branch));
        Ok(())
    }

    #[test]
    fn effective_scope_fails_closed_on_org_mismatch() -> Result<(), KernelError> {
        let effective = effective_branch_scope_for_tenant(
            BranchScope::All,
            AccessScope::legacy_org(OrgId::new()),
            OrgId::new(),
        )?;

        assert_eq!(effective, BranchScope::none());
        Ok(())
    }

    #[test]
    fn effective_scope_branch_claim_narrows_live_all() -> Result<(), KernelError> {
        let org = OrgId::new();
        let branch = BranchId::new();
        let scope = AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*branch.as_uuid()),
        );

        let effective = effective_branch_scope_for_tenant(BranchScope::All, scope, org)?;

        assert_eq!(effective, BranchScope::single(branch));
        Ok(())
    }

    #[test]
    fn effective_scope_branch_claim_intersects_live_memberships() -> Result<(), KernelError> {
        let org = OrgId::new();
        let branch = BranchId::new();
        let other = BranchId::new();
        let scope = AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*branch.as_uuid()),
        );

        let allowed = effective_branch_scope_for_tenant(BranchScope::single(branch), scope, org)?;
        let denied = effective_branch_scope_for_tenant(BranchScope::single(other), scope, org)?;

        assert_eq!(allowed, BranchScope::single(branch));
        assert_eq!(denied, BranchScope::none());
        Ok(())
    }

    #[test]
    fn effective_scope_rejects_group_on_ordinary_tenant_routes() {
        let err_kind = effective_branch_scope_for_tenant(
            BranchScope::All,
            AccessScope::new(
                AccessScopeLevel::Group,
                ScopeNodeId::from_uuid(uuid::Uuid::new_v4()),
            ),
            OrgId::new(),
        )
        .err()
        .map(|err| err.kind);

        assert_eq!(err_kind, Some(ErrorKind::Forbidden));
    }

    #[test]
    fn effective_scope_sub_org_levels_without_projection_fail_closed() -> Result<(), KernelError> {
        for level in [AccessScopeLevel::Region, AccessScopeLevel::Worksite] {
            let effective = effective_branch_scope_for_tenant(
                BranchScope::All,
                AccessScope::new(level, ScopeNodeId::from_uuid(uuid::Uuid::new_v4())),
                OrgId::new(),
            )?;

            assert_eq!(effective, BranchScope::none());
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // authorize_capability — the branch-less primitive
    // -----------------------------------------------------------------------

    fn principal_with(roles: [Role; 1], scope: BranchScope) -> Principal {
        Principal::new(
            UserId::new(),
            OrgId::one(),
            std::collections::BTreeSet::from(roles),
            scope,
        )
    }

    /// The approval inbox must not empty out. `CompletionReview` is
    /// `[D,D,D,A,D,A]`; routing these sites through `authorize_org_wide` instead
    /// would have collapsed them to SUPER_ADMIN only.
    #[test]
    fn capability_preserves_builtin_admin_on_completion_review() {
        let branch = BranchId::new();
        let admin = principal_with([Role::Admin], BranchScope::single(branch));
        let action = Action::new(Feature::CompletionReview);

        assert!(authorize_capability(&admin, action).is_ok());
        // Same verdict the fabricated-branch call produced.
        assert!(authorize(&admin, action, branch).is_ok());
        // ...and what org-wide routing would have done instead.
        assert!(authorize_org_wide(&admin, action).is_err());
    }

    /// `Feature::TargetManage` is `[D,D,R,A,D,A]` — MECHANIC holds `RequestOnly`.
    /// A hardcoded `== PermissionLevel::Allow` capability check would deny every
    /// mechanic on the request-only target surface.
    #[test]
    fn capability_honors_request_only_permission_level() {
        let mechanic = principal_with([Role::Mechanic], BranchScope::single(BranchId::new()));

        assert!(authorize_capability(&mechanic, Action::request(Feature::TargetManage)).is_ok());
        assert!(authorize_capability(&mechanic, Action::new(Feature::TargetManage)).is_err());
    }

    /// The grant must COVER the principal's scope. A Seoul-only grant does not
    /// authorize a Seoul+Busan principal for an action that reaches both.
    #[test]
    fn capability_denies_grant_narrower_than_principal_scope() {
        let seoul = BranchId::new();
        let busan = BranchId::new();
        let member = principal_with(
            [Role::Member],
            BranchScope::Branches(std::collections::BTreeSet::from([seoul, busan])),
        )
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::CompletionReview,
            PermissionLevel::Allow,
            BranchScope::single(seoul),
        )]);

        assert!(authorize_capability(&member, Action::new(Feature::CompletionReview)).is_err());
    }

    /// THE ONE BEHAVIOURAL DELTA, as a differential against what shipped.
    ///
    /// The losing class: ≥2 branches, no built-in role permission, a custom grant
    /// covering only part of the scope. The first two assertions are the
    /// pre-migration verdict for that class — the SAME partial grant admits or
    /// denies depending only on which branch UUID sorts first in the `BTreeSet`,
    /// because the fabricated branch was `branches.iter().next()`. The last two
    /// are this function: denied either way.
    #[test]
    fn capability_replaces_an_order_dependent_grant_verdict_with_a_deny() {
        let mut ids = [BranchId::new(), BranchId::new()];
        ids.sort();
        let [lowest, other] = ids;
        let scope = BranchScope::Branches(std::collections::BTreeSet::from(ids));
        let action = Action::new(Feature::CompletionReview);
        let granted_on = |branch| {
            principal_with([Role::Member], scope.clone()).with_effective_feature_grants(vec![
                EffectiveFeatureGrant::new(
                    Feature::CompletionReview,
                    PermissionLevel::Allow,
                    BranchScope::single(branch),
                ),
            ])
        };

        assert!(
            authorize(&granted_on(lowest), action, lowest).is_ok(),
            "pre-migration: a partial grant on the lowest-sorting branch was ALLOWED"
        );
        assert!(
            authorize(&granted_on(other), action, lowest).is_err(),
            "pre-migration: the same partial grant on the other branch was DENIED"
        );

        assert!(authorize_capability(&granted_on(lowest), action).is_err());
        assert!(authorize_capability(&granted_on(other), action).is_err());
    }

    /// ...and the other direction: a grant that covers more than the principal's
    /// scope still authorizes.
    #[test]
    fn capability_allows_grant_covering_principal_scope() {
        let seoul = BranchId::new();
        let busan = BranchId::new();
        let member = principal_with([Role::Member], BranchScope::single(seoul))
            .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                Feature::CompletionReview,
                PermissionLevel::Allow,
                BranchScope::Branches(std::collections::BTreeSet::from([seoul, busan])),
            )]);

        assert!(authorize_capability(&member, Action::new(Feature::CompletionReview)).is_ok());
    }

    /// For an `All`-scoped principal the coverage rule collapses to exactly
    /// `authorize_org_wide`'s grant rule: only an `All` grant passes.
    #[test]
    fn capability_denies_partial_grant_for_all_scoped_principal() {
        let partial = principal_with([Role::Member], BranchScope::All)
            .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                Feature::CompletionReview,
                PermissionLevel::Allow,
                BranchScope::single(BranchId::new()),
            )]);
        let org_wide = principal_with([Role::Member], BranchScope::All)
            .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                Feature::CompletionReview,
                PermissionLevel::Allow,
                BranchScope::All,
            )]);

        assert!(authorize_capability(&partial, Action::new(Feature::CompletionReview)).is_err());
        assert!(authorize_capability(&org_wide, Action::new(Feature::CompletionReview)).is_ok());
    }

    /// A principal with zero memberships is denied whatever it holds — matching
    /// every helper this primitive replaced.
    #[test]
    fn capability_denies_empty_branch_scope_regardless_of_role() {
        for role in Role::ALL {
            let principal = principal_with([role], BranchScope::none())
                .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                    Feature::Login,
                    PermissionLevel::Allow,
                    BranchScope::All,
                )]);
            assert!(
                authorize_capability(&principal, Action::new(Feature::Login)).is_err(),
                "{role:?} with empty scope must be denied"
            );
        }
    }

    /// The no-outage property, stated as a differential: with no custom grants,
    /// `authorize_capability` agrees with `authorize` for EVERY branch in the
    /// principal's scope — including the one the fabrication happened to pick.
    #[test]
    fn capability_agrees_with_authorize_on_every_in_scope_branch() {
        let branches = [BranchId::new(), BranchId::new(), BranchId::new()];
        let scope = BranchScope::Branches(branches.into_iter().collect());

        for role in Role::ALL {
            let principal = principal_with([role], scope.clone());
            for feature in Feature::ALL {
                for action in [
                    Action::new(feature),
                    Action::limited(feature),
                    Action::request(feature),
                ] {
                    let capability = authorize_capability(&principal, action).is_ok();
                    for branch in branches {
                        assert_eq!(
                            capability,
                            authorize(&principal, action, branch).is_ok(),
                            "{role:?}/{feature:?} disagreed on an in-scope branch"
                        );
                    }
                }
            }
        }
    }

    /// The branch dimension is still real where a branch exists: an out-of-scope
    /// resource branch denies through `authorize`. `authorize_capability` is for
    /// resources that have no branch, not a way to skip this check.
    #[test]
    fn authorize_still_denies_a_resource_branch_outside_scope() {
        let mine = BranchId::new();
        let theirs = BranchId::new();
        let admin = principal_with([Role::Admin], BranchScope::single(mine));
        let action = Action::new(Feature::CompletionReview);

        assert!(authorize(&admin, action, mine).is_ok());
        assert!(authorize(&admin, action, theirs).is_err());
    }

    /// STRICTER OR EQUAL, for every principal shape a migrated site can meet.
    ///
    /// `before` reproduces the fabricated-branch call verbatim — `BranchId::new()`
    /// for `All`, `branches.iter().next()` otherwise — and `after` is the
    /// primitive that replaced it, over all 100 features × all three permission
    /// levels. The assertion runs one way only: nothing `after` admits may have
    /// been denied `before`. Widening is what F1 proved can happen by accident, so
    /// it is asserted rather than argued.
    ///
    /// Run with `--nocapture` to print the per-shape before/after counts.
    #[test]
    fn capability_is_stricter_or_equal_for_every_principal_shape() {
        let branch = BranchId::new();
        let second = BranchId::new();
        let grant = |feature, scope| {
            vec![EffectiveFeatureGrant::new(
                feature,
                PermissionLevel::Allow,
                scope,
            )]
        };

        let shapes: Vec<(&str, Principal)> = vec![
            (
                "group-admin ADMIN ({Admin}+All)",
                principal_with([Role::Admin], BranchScope::All),
            ),
            (
                "branch-scoped ADMIN",
                principal_with([Role::Admin], BranchScope::single(branch)),
            ),
            (
                "MECHANIC",
                principal_with([Role::Mechanic], BranchScope::single(branch)),
            ),
            (
                "RECEPTIONIST",
                principal_with([Role::Receptionist], BranchScope::single(branch)),
            ),
            (
                "Executive",
                principal_with([Role::Executive], BranchScope::All),
            ),
            (
                "SuperAdmin",
                principal_with([Role::SuperAdmin], BranchScope::All),
            ),
            (
                "empty-scope principal",
                principal_with([Role::Admin], BranchScope::none()),
            ),
            (
                "grant-only (covering)",
                principal_with([Role::Member], BranchScope::single(branch))
                    .with_effective_feature_grants(grant(
                        Feature::CompletionReview,
                        BranchScope::single(branch),
                    )),
            ),
            (
                "grant-only (partial, 2 branches)",
                principal_with(
                    [Role::Member],
                    BranchScope::Branches(std::collections::BTreeSet::from([branch, second])),
                )
                .with_effective_feature_grants(grant(
                    Feature::CompletionReview,
                    BranchScope::single(*[branch, second].iter().min().unwrap()),
                )),
            ),
        ];

        for (label, principal) in &shapes {
            let (mut before_allowed, mut after_allowed) = (0usize, 0usize);
            for feature in Feature::ALL {
                for action in [
                    Action::new(feature),
                    Action::limited(feature),
                    Action::request(feature),
                ] {
                    let fabricated = match &principal.branch_scope {
                        // fabricated-branch: ok this IS the fabrication, reproduced as a test fixture
                        BranchScope::All => Some(BranchId::new()),
                        // fabricated-branch: ok same, the `Branches` half of the same fixture
                        BranchScope::Branches(branches) => branches.iter().next().copied(),
                    };
                    let before =
                        fabricated.is_some_and(|b| authorize(principal, action, b).is_ok());
                    let after = authorize_capability(principal, action).is_ok();
                    before_allowed += usize::from(before);
                    after_allowed += usize::from(after);
                    assert!(
                        !(after && !before),
                        "{label}: {feature:?}/{:?} is WIDER after the migration",
                        action.required_permission()
                    );
                }
            }
            println!("{label}: before={before_allowed} after={after_allowed} allows");
        }
    }

    /// NOTHING BROKE, site by site. Every feature that a migrated
    /// fabricated-branch helper gates, with the verdict a branch-scoped built-in
    /// ADMIN gets today. `false` entries are ADMIN-DENY in the matrix and must
    /// stay denied; every `true` entry is a surface an ADMIN uses today and must
    /// keep — the `CompletionReview` row is the approval inbox.
    ///
    /// Each row also asserts the fabricated-branch call this replaced agrees, so
    /// the table cannot drift from the behavior it is protecting.
    #[test]
    fn migrated_sites_keep_todays_admin_verdict() {
        let branch = BranchId::new();
        let admin = principal_with([Role::Admin], BranchScope::single(branch));

        let sites: &[(&str, Action, bool)] = &[
            // workorder/rest authorize_feature_in_scope — the approval inbox.
            (
                "workorder: CompletionReview",
                Action::new(Feature::CompletionReview),
                true,
            ),
            (
                "workorder: WorkOrderReadAll",
                Action::new(Feature::WorkOrderReadAll),
                true,
            ),
            (
                "workorder: DailyPlanRequest",
                Action::new(Feature::DailyPlanRequest),
                true,
            ),
            (
                "workorder: DailyPlanReview",
                Action::new(Feature::DailyPlanReview),
                true,
            ),
            (
                "workorder: OrgWideQueueTriage (ADMIN deny today)",
                Action::new(Feature::OrgWideQueueTriage),
                false,
            ),
            (
                "workorder: TargetManage",
                Action::new(Feature::TargetManage),
                true,
            ),
            // identity/rest authorize_org_manage.
            (
                "identity: UserManage",
                Action::new(Feature::UserManage),
                true,
            ),
            ("identity: Login", Action::new(Feature::Login), true),
            (
                "identity: RoleManage (ADMIN deny today)",
                Action::new(Feature::RoleManage),
                false,
            ),
            (
                "identity: RegionManage",
                Action::new(Feature::RegionManage),
                true,
            ),
            (
                "identity: BranchManage",
                Action::new(Feature::BranchManage),
                true,
            ),
            (
                "identity: ElevatedRoleGrant (ADMIN deny today)",
                Action::new(Feature::ElevatedRoleGrant),
                false,
            ),
            // sales/rest, analytics-quant/rest, comms/rest.
            (
                "sales: SalesManage",
                Action::new(Feature::SalesManage),
                true,
            ),
            ("analytics: KpiRead", Action::new(Feature::KpiRead), true),
            (
                "comms: MailAccountManage",
                Action::new(Feature::MailAccountManage),
                true,
            ),
            ("comms: MailUse", Action::new(Feature::MailUse), true),
            // compliance/integrity — ADMIN is DENY today and stays DENY.
            (
                "integrity: IntegrityFindingsRead (ADMIN deny today)",
                Action::new(Feature::IntegrityFindingsRead),
                false,
            ),
            (
                "integrity: IntegrityFindingTriage (ADMIN deny today)",
                Action::new(Feature::IntegrityFindingTriage),
                false,
            ),
            // inspection/rest list gates.
            (
                "inspection: InspectionScheduleManage",
                Action::new(Feature::InspectionScheduleManage),
                true,
            ),
            (
                "inspection: InspectionRoundComplete",
                Action::new(Feature::InspectionRoundComplete),
                true,
            ),
            // evaluation/rest, leave/rest + benefit/rest Branches arm.
            (
                "evaluation: EvaluationRead",
                Action::new(Feature::EvaluationRead),
                true,
            ),
            (
                "evaluation: EvaluationManage",
                Action::new(Feature::EvaluationManage),
                true,
            ),
            (
                "evaluation: EvaluationSubmit",
                Action::new(Feature::EvaluationSubmit),
                true,
            ),
            (
                "leave: EmployeeDirectoryRead",
                Action::new(Feature::EmployeeDirectoryRead),
                true,
            ),
            (
                "leave: EmployeeDirectoryManage",
                Action::new(Feature::EmployeeDirectoryManage),
                true,
            ),
            // app/src/lib.rs authorize_audit_read.
            (
                "app: AuditLogRead",
                Action::new(Feature::AuditLogRead),
                true,
            ),
            // support/rest list gates share Login + WorkOrderReadAll, above.
        ];

        for (site, action, admin_allowed) in sites {
            assert_eq!(
                authorize_capability(&admin, *action).is_ok(),
                *admin_allowed,
                "{site}: migrated verdict changed for a branch-scoped ADMIN"
            );
            assert_eq!(
                authorize(&admin, *action, branch).is_ok(),
                *admin_allowed,
                "{site}: the pre-migration fabricated-branch call disagrees, so \
                 this table no longer describes what shipped"
            );
        }
    }

    // -----------------------------------------------------------------------
    // `authorize_scoped` — the branchless/branch spine with decision-time grants
    // -----------------------------------------------------------------------

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_unix_timestamp(secs).unwrap()
    }

    /// `None` is branch-less capability authorization, byte-for-byte.
    #[test]
    fn none_is_branchless_capability_authorization_for_every_principal_shape() {
        let branches = [BranchId::new(), BranchId::new()];
        let scopes = [
            BranchScope::All,
            BranchScope::single(branches[0]),
            BranchScope::Branches(branches.into_iter().collect()),
            BranchScope::none(),
        ];

        for role in Role::ALL {
            for scope in &scopes {
                let principal = principal_with([role], scope.clone());
                for feature in Feature::ALL {
                    for action in [
                        Action::new(feature),
                        Action::limited(feature),
                        Action::request(feature),
                    ] {
                        assert_eq!(
                            authorize_capability_at(&principal, action, ts(1_000)).is_ok(),
                            authorize_capability(&principal, action).is_ok(),
                            "{role:?}/{feature:?}: the branch-less door must BE authorize_capability"
                        );
                    }
                }
            }
        }
    }

    /// `Some(b)` is branch authorization, byte-for-byte — including the deny for
    /// a branch outside the principal's scope.
    #[test]
    fn some_is_branch_authorization_for_every_principal_shape() {
        let mine = BranchId::new();
        let theirs = BranchId::new();

        for role in Role::ALL {
            for scope in [BranchScope::All, BranchScope::single(mine)] {
                let principal = principal_with([role], scope);
                for feature in Feature::ALL {
                    let action = Action::new(feature);
                    for branch in [mine, theirs] {
                        assert_eq!(
                            authorize_scoped(
                                &principal,
                                action,
                                ResourceBranch::for_test(principal.org_id, branch),
                                ts(1_000),
                            )
                            .is_ok(),
                            authorize(&principal, action, branch).is_ok(),
                            "{role:?}/{feature:?}: a resource branch must BE authorize"
                        );
                    }
                }
            }
        }
    }

    /// CROSS-TENANT. The tenant a branch was read under is part of what makes a
    /// `ResourceBranch` a proof: a row id is a bare uuid, so a call site that
    /// takes the org from the same request path as the id (`path.org_id`) can
    /// name a tenant the principal does not belong to. The lookup then succeeds
    /// against THAT tenant's row, and for a `BranchScope::All` principal
    /// `allows(branch)` is unconditionally true — an ALLOW against another
    /// tenant's resource.
    ///
    /// So the decision checks the org too, and the principal is the only side
    /// that can supply it.
    #[test]
    fn a_resource_branch_read_under_another_tenant_is_denied_however_wide_the_scope() {
        let branch = BranchId::new();
        let principal = principal_with([Role::Admin], BranchScope::All);
        let action = Action::new(Feature::CompletionReview);
        let other_tenant = OrgId::from_uuid(uuid::Uuid::from_u128(0xb0b));
        assert_ne!(other_tenant, principal.org_id);

        // THE CONTROL: the same branch, read under the principal's own org, is
        // an ordinary allow — so the refusal below is the tenant and nothing
        // else about the fixture.
        assert!(
            authorize_scoped(
                &principal,
                action,
                ResourceBranch::for_test(principal.org_id, branch),
                ts(1),
            )
            .is_ok()
        );

        let err = authorize_scoped(
            &principal,
            action,
            ResourceBranch::for_test(other_tenant, branch),
            ts(1),
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Forbidden);
    }

    /// The fold every REST list gate performs over
    /// `principal.effective_feature_grants` verbatim: match on feature +
    /// permission, take the grant's `branch_scope`. `inventory/rest`'s and
    /// `dispatch/rest`'s `custom_feature_scope`, and
    /// `identity/rest`'s `principal_holds_policy_permission`, are all this
    /// shape. None of them takes a decision instant, so none of them can
    /// consult an interval — which is exactly why an effective-dated grant
    /// must be UNREACHABLE from this field rather than merely filtered out of
    /// it by every reader remembering to.
    fn scope_a_time_blind_caller_reads(
        principal: &Principal,
        feature: Feature,
    ) -> Vec<BranchScope> {
        principal
            .effective_feature_grants
            .iter()
            .filter(|grant| {
                grant.feature == feature && grant.permission.satisfies(PermissionLevel::Allow)
            })
            .map(|grant| grant.branch_scope.clone())
            .collect()
    }

    /// An expired grant must be invisible to a reader that never asked what
    /// time it is — including a reader outside this crate that this crate
    /// cannot patch. The guarantee has to be that the field CANNOT hold one.
    #[test]
    fn an_expired_grant_is_unreachable_from_the_time_blind_grant_list() {
        let branch = BranchId::new();
        let expired = principal_with([Role::Member], BranchScope::single(branch))
            .with_dated_feature_grants(vec![DatedFeatureGrant::new(
                EffectiveFeatureGrant::new(
                    Feature::WorkOrderCreate,
                    PermissionLevel::Allow,
                    BranchScope::single(branch),
                ),
                GrantValidity::half_open(ts(100), Some(ts(200))).unwrap(),
            )]);

        assert!(
            scope_a_time_blind_caller_reads(&expired, Feature::WorkOrderCreate).is_empty(),
            "a dated grant must never appear in the field time-blind callers fold over"
        );
        assert!(
            authorize_capability_at(&expired, Action::new(Feature::WorkOrderCreate), ts(250))
                .is_err(),
            "and the decision-time door must still deny it after valid_to"
        );
    }

    fn dated_grant(validity: GrantValidity) -> Principal {
        let branch = BranchId::new();
        principal_with([Role::Member], BranchScope::single(branch)).with_dated_feature_grants(vec![
            DatedFeatureGrant::new(
                EffectiveFeatureGrant::new(
                    Feature::WorkOrderCreate,
                    PermissionLevel::Allow,
                    BranchScope::single(branch),
                ),
                validity,
            ),
        ])
    }

    /// Both ends of the grant interval, probed explicitly through a real
    /// authorization decision — not just through `GrantValidity::contains`.
    #[test]
    fn a_dated_grant_is_effective_from_valid_from_inclusive_to_valid_to_exclusive() {
        let principal = dated_grant(GrantValidity::half_open(ts(100), Some(ts(200))).unwrap());
        let action = Action::new(Feature::WorkOrderCreate);

        assert!(authorize_capability_at(&principal, action, ts(99)).is_err());
        assert!(
            authorize_capability_at(&principal, action, ts(100)).is_ok(),
            "valid_from is INSIDE the interval"
        );
        assert!(authorize_capability_at(&principal, action, ts(199)).is_ok());
        assert!(
            authorize_capability_at(&principal, action, ts(200)).is_err(),
            "valid_to is OUTSIDE the interval"
        );
        assert!(authorize_capability_at(&principal, action, ts(201)).is_err());
    }

    /// The same two ends on the branch-scoped door, so it cannot quietly skip the
    /// interval predicate the branch-less door enforces.
    #[test]
    fn the_branch_arm_honors_both_interval_ends_too() {
        let branch = BranchId::new();
        let principal = principal_with([Role::Member], BranchScope::single(branch))
            .with_dated_feature_grants(vec![DatedFeatureGrant::new(
                EffectiveFeatureGrant::new(
                    Feature::WorkOrderCreate,
                    PermissionLevel::Allow,
                    BranchScope::single(branch),
                ),
                GrantValidity::half_open(ts(100), Some(ts(200))).unwrap(),
            )]);
        let action = Action::new(Feature::WorkOrderCreate);
        let resource = ResourceBranch::for_test(principal.org_id, branch);

        assert!(authorize_scoped(&principal, action, resource, ts(99)).is_err());
        assert!(authorize_scoped(&principal, action, resource, ts(100)).is_ok());
        assert!(authorize_scoped(&principal, action, resource, ts(199)).is_ok());
        assert!(authorize_scoped(&principal, action, resource, ts(200)).is_err());
    }

    /// ADR-0032 §3/§6: the grant set is resolved WHEN THE DECISION IS MADE.
    /// Crossing an interval boundary is not a write, so no freshness counter can
    /// record it; the same principal value must yield different verdicts at
    /// different instants from the same call site.
    #[test]
    fn the_grant_set_resolves_at_decision_time_not_once_per_principal() {
        let principal = dated_grant(GrantValidity::half_open(ts(100), Some(ts(200))).unwrap());
        let action = Action::new(Feature::WorkOrderCreate);

        let verdicts: Vec<bool> = [ts(50), ts(150), ts(250), ts(150)]
            .into_iter()
            .map(|at| authorize_capability_at(&principal, action, at).is_ok())
            .collect();

        assert_eq!(verdicts, vec![false, true, false, true]);
    }

    /// FAIL CLOSED. `authorize`, `authorize_capability` and `authorize_org_wide`
    /// take no instant, so they cannot evaluate an interval. An effective-dated
    /// grant is therefore INVISIBLE to them — it can never widen a time-blind
    /// decision, not even inside its own interval.
    #[test]
    fn an_effective_dated_grant_is_invisible_to_the_time_blind_entry_points() {
        let branch = BranchId::new();
        let scope = BranchScope::single(branch);
        let grant = EffectiveFeatureGrant::new(
            Feature::WorkOrderCreate,
            PermissionLevel::Allow,
            scope.clone(),
        );
        let action = Action::new(Feature::WorkOrderCreate);

        let undated = principal_with([Role::Member], scope.clone())
            .with_effective_feature_grants(vec![grant.clone()]);
        let dated = principal_with([Role::Member], scope).with_dated_feature_grants(vec![
            DatedFeatureGrant::new(
                grant,
                GrantValidity::half_open(ts(100), Some(ts(200))).unwrap(),
            ),
        ]);

        // The undated grant is what ships today, and it still authorizes.
        assert!(authorize_capability(&undated, action).is_ok());
        assert!(authorize(&undated, action, branch).is_ok());

        // The dated one does not, at any instant, through a time-blind door.
        assert!(authorize_capability(&dated, action).is_err());
        assert!(authorize(&dated, action, branch).is_err());
        // ...but it does through the decision-time door, inside its interval.
        assert!(authorize_capability_at(&dated, action, ts(150)).is_ok());
    }

    /// An all-branch principal whose org-wide authority comes only from a dated
    /// custom grant must not pass the time-blind org-wide gate either.
    #[test]
    fn an_effective_dated_grant_is_invisible_to_authorize_org_wide() {
        let action = Action::new(Feature::WorkOrderCreate);
        let grant = EffectiveFeatureGrant::new(
            Feature::WorkOrderCreate,
            PermissionLevel::Allow,
            BranchScope::All,
        );

        let undated = principal_with([Role::Member], BranchScope::All)
            .with_effective_feature_grants(vec![grant.clone()]);
        let dated =
            principal_with([Role::Member], BranchScope::All).with_dated_feature_grants(vec![
                DatedFeatureGrant::new(
                    grant,
                    GrantValidity::half_open(ts(100), Some(ts(200))).unwrap(),
                ),
            ]);

        assert!(authorize_org_wide(&undated, action).is_ok());
        assert!(authorize_org_wide(&dated, action).is_err());
    }

    /// ADR-0032 §1 is enforced HERE or nowhere. `enforce_assignment_non_overlap`
    /// was defined, unit tested and never called: every reference to it in the
    /// tree was its own definition, its re-export or its own tests, and the
    /// resolver folded straight over the assignment rows. A predicate that is
    /// never applied is not a guard.
    ///
    /// The fold lives behind the check, so grants cannot be produced without it
    /// having run — and this test says what happens when it does. Delete the
    /// `enforce_assignment_non_overlap(..)?` line and the second half returns
    /// one grant instead of a `Conflict`.
    ///
    /// The input is the ROWS, not a hand-built assignment set: the checked set
    /// used to be a separate argument, and an argument the resolver supplies is
    /// an argument a resolver edit can supply empty — with the guard still
    /// nominally called, still returning `Ok`, and no test able to tell. There
    /// is no such argument now, so this drives the same derivation production
    /// drives.
    #[test]
    fn an_ambiguous_assignment_set_refuses_to_produce_grants() {
        let role = uuid::Uuid::from_u128(0xa);
        let scopes = BTreeMap::from([(role, BranchScope::All)]);
        let row = |assignment: u128| RuntimePolicyPermissionRow {
            assignment_id: uuid::Uuid::from_u128(assignment),
            role_id: role,
            feature_key: Feature::WorkOrderCreate.as_str().to_owned(),
            permission_level: PermissionLevel::Allow.as_str().to_owned(),
        };

        // THE CONTROL: one 발령 for the role folds into one grant, so the
        // refusal below is the overlap and not the fixture.
        let unambiguous = effective_grants_from_checked_assignments(vec![row(1)], &scopes).unwrap();
        assert_eq!(unambiguous.len(), 1);

        // Two records claiming when this one authority began. The resolver must
        // refuse the set, not pick one and fold.
        let ambiguous =
            effective_grants_from_checked_assignments(vec![row(1), row(2)], &scopes).unwrap_err();
        assert_eq!(ambiguous.kind, ErrorKind::Conflict);
    }

    /// The guard above is only a guard if the resolver hands it one entry per
    /// 발령. The permission join repeats an assignment once per permission, so
    /// the rows are folded to the assignment first — and that fold is where the
    /// guard can be switched off without any other test noticing: key the map
    /// by `role_id` instead of the assignment id and two records for one role
    /// collapse into one entry, after which `enforce_assignment_non_overlap`
    /// can never fire again.
    #[test]
    fn one_assignment_is_one_entry_however_many_permissions_it_carries() {
        let role = uuid::Uuid::from_u128(0xa);
        let row = |assignment: u128, feature: Feature| RuntimePolicyPermissionRow {
            assignment_id: uuid::Uuid::from_u128(assignment),
            role_id: role,
            feature_key: feature.as_str().to_owned(),
            permission_level: PermissionLevel::Allow.as_str().to_owned(),
        };

        // One 발령 carrying two permissions is ONE assignment. Two entries here
        // would refuse every user who holds a role with more than one feature.
        let one_appointment = assignment_validities(&[
            row(1, Feature::WorkOrderCreate),
            row(1, Feature::CompletionReview),
        ]);
        assert_eq!(one_appointment.len(), 1);

        // Two 발령 for the same role are TWO assignments — the ambiguity the
        // guard exists to refuse. One entry here is the guard going silent.
        let two_appointments = assignment_validities(&[
            row(1, Feature::WorkOrderCreate),
            row(2, Feature::WorkOrderCreate),
        ]);
        assert_eq!(two_appointments.len(), 2);
        assert!(enforce_assignment_non_overlap(&two_appointments).is_err());
    }

    /// A grant carrying no interval keeps today's behaviour exactly, on every
    /// door. This is the whole no-regression claim of the temporal change.
    #[test]
    fn an_interval_less_grant_decides_identically_on_every_entry_point() {
        let branch = BranchId::new();
        let scope = BranchScope::single(branch);

        for feature in Feature::ALL {
            for permission in [PermissionLevel::Allow, PermissionLevel::Limited] {
                let principal = principal_with([Role::Member], scope.clone())
                    .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                        feature,
                        permission,
                        scope.clone(),
                    )]);
                for action in [
                    Action::new(feature),
                    Action::limited(feature),
                    Action::request(feature),
                ] {
                    assert_eq!(
                        authorize_capability_at(&principal, action, ts(1)).is_ok(),
                        authorize_capability(&principal, action).is_ok(),
                        "{feature:?}/{permission:?}: branchless verdict moved"
                    );
                    assert_eq!(
                        authorize_scoped(
                            &principal,
                            action,
                            ResourceBranch::for_test(principal.org_id, branch),
                            ts(1),
                        )
                        .is_ok(),
                        authorize(&principal, action, branch).is_ok(),
                        "{feature:?}/{permission:?}: branch verdict moved"
                    );
                }
            }
        }
    }

    /// Totality pin for custom-role runtime restrictions, including the retired
    /// v1 AI permission. Historical rows must never resolve to live grants.
    #[test]
    fn custom_role_runtime_feature_allowed_blocks_only_the_safety_set() {
        let blocked = [
            Feature::RoleManage,
            Feature::ElevatedRoleGrant,
            Feature::OrgWideQueueTriage,
            Feature::AuditStreamRead,
            Feature::AuditStreamAccessLogRead,
            Feature::AiAssist,
            Feature::SettingsManage,
            Feature::ReasonCodeManage,
            Feature::ExceptionDecide,
            Feature::ApprovalRouteManage,
            Feature::ChangeRequestDecide,
            Feature::JobTitleManage,
            Feature::RetainedRecordsRead,
            Feature::TenantOffboard,
            Feature::LegalEntityManage,
            Feature::OrgUnitManage,
        ];
        for feature in Feature::ALL {
            let expected = !blocked.contains(&feature);
            assert_eq!(
                custom_role_runtime_feature_allowed(feature),
                expected,
                "{feature:?}"
            );
        }
        assert!(!custom_role_runtime_feature_allowed(Feature::AiAssist));
    }

    #[test]
    fn retired_ai_grant_cannot_authorize_a_scoped_resource() {
        let branch = BranchId::new();
        let principal = principal_with([Role::SuperAdmin], BranchScope::single(branch))
            .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                Feature::AiAssist,
                PermissionLevel::Allow,
                BranchScope::single(branch),
            )]);
        for action in [
            Action::new(Feature::AiAssist),
            Action::limited(Feature::AiAssist),
            Action::request(Feature::AiAssist),
        ] {
            assert!(
                authorize_scoped(
                    &principal,
                    action,
                    ResourceBranch::for_test(principal.org_id, branch),
                    ts(1),
                )
                .is_err()
            );
        }
    }
}
