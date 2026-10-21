//! The door projection: only Cedar-allowed keys, over the grant's branches.

use std::collections::BTreeSet;

use console_kernel_core::{BranchId, BranchScope};
use uuid::Uuid;

use super::catalog::{Domain, Level};
use super::model::{NodeKind, NodePath};
use super::project::project;
use super::tests::{grant, line, n, subject, tree};
use crate::PermissionLevel;

#[test]
fn the_projection_carries_only_cedar_allowed_keys_over_the_grant_branches() {
    let t = tree();
    let b1 = BranchId::from_uuid(Uuid::new_v4());
    let wp_branches = BranchScope::Branches(BTreeSet::from([b1]));
    let g = grant(
        t.wp_a1(),
        vec![line(Domain::HrBasic, &[Level::Edit])],
        wp_branches.clone(),
    );
    let p = project(&subject(&t, false, vec![g]));
    assert!(p.errors.is_empty(), "{:?}", p.errors);
    assert_eq!(p.branches, wp_branches);
    let mut features: Vec<&str> = p.grants.iter().map(|g| g.feature.as_str()).collect();
    features.sort_unstable();
    assert_eq!(
        features,
        [
            "employee_directory_manage",
            "employee_directory_read",
            "login",
            "master_list_import"
        ]
    );
    assert!(
        p.grants
            .iter()
            .all(|g| g.permission == PermissionLevel::Allow && g.branch_scope == wp_branches)
    );
}

#[test]
fn ops_and_empty_subjects_project_nothing() {
    let t = tree();
    let g = grant(
        t.tenant(),
        vec![line(Domain::Org, &[Level::View])],
        BranchScope::All,
    );
    assert!(project(&subject(&t, true, vec![g])).grants.is_empty());
    let p = project(&subject(&t, false, vec![]));
    assert!(p.grants.is_empty());
    assert_eq!(p.branches, BranchScope::Branches(BTreeSet::new()));
}

#[test]
fn a_grant_whose_chain_is_broken_projects_nothing() {
    let t = tree();
    let broken = NodePath(vec![
        n(NodeKind::Workplace, t.wp_a1),
        n(NodeKind::Tenant, *t.org.as_uuid()),
    ]);
    let g = grant(
        broken,
        vec![line(Domain::Org, &[Level::View])],
        BranchScope::All,
    );
    let p = project(&subject(&t, false, vec![g]));
    assert!(p.grants.is_empty());
    assert!(!p.errors.is_empty());
}

/// regression: governance-02 — a 회사 전체 권한 관리 grant does not widen the
/// data scope of a narrower 인사 grant; alone, it keeps its own scope.
#[test]
fn a_tenant_level_grant_does_not_widen_the_data_scope() {
    let t = tree();
    let b1 = BranchId::from_uuid(Uuid::new_v4());
    let wp_branches = BranchScope::Branches(BTreeSet::from([b1]));
    let hr = grant(
        t.wp_a1(),
        vec![line(Domain::HrBasic, &[Level::View])],
        wp_branches.clone(),
    );
    let access = || {
        grant(
            t.tenant(),
            vec![line(Domain::Access, &[Level::Edit])],
            BranchScope::All,
        )
    };
    let p = project(&subject(&t, false, vec![hr, access()]));
    assert_eq!(p.branches, wp_branches);
    assert!(
        p.grants
            .iter()
            .any(|g| g.feature.as_str() == "user_manage" && g.branch_scope == BranchScope::All)
    );
    let alone = project(&subject(&t, false, vec![access()]));
    assert_eq!(alone.branches, BranchScope::All);
}

/// A holder of any grant is a working member (the `Login` door opens over its
/// scope); a subject with no grant gets nothing, not even membership.
#[test]
fn a_held_grant_opens_the_membership_door_over_its_scope() {
    let t = tree();
    let b1 = BranchId::from_uuid(Uuid::new_v4());
    let wp_branches = BranchScope::Branches(BTreeSet::from([b1]));
    let g = grant(
        t.wp_a1(),
        vec![line(Domain::Org, &[Level::View])],
        wp_branches.clone(),
    );
    let p = project(&subject(&t, false, vec![g]));
    assert!(
        p.grants
            .iter()
            .any(|g| g.feature.as_str() == "login" && g.branch_scope == wp_branches)
    );
    let none = project(&subject(&t, false, vec![]));
    assert!(none.grants.iter().all(|g| g.feature.as_str() != "login"));
}
