//! Cedar decisions per level and scope, ops break-glass, fail-closed chains,
//! and the door projection (decision #26 pilot slice).

use console_kernel_core::{BranchScope, OrgId, TenantPhase};
use uuid::Uuid;

use super::catalog::{Domain, Level, action_group, normalize_levels};
use super::cedar::{AccessEngineError, AccessSlice, schema_source};
use super::model::{AccessSubject, HeldGrant, NodeKind, NodePath, NodeRef, RoleLine};
use crate::Feature;

pub(super) struct Tree {
    pub(super) org: OrgId,
    pub(super) le_a: Uuid,
    pub(super) le_b: Uuid,
    pub(super) wp_a1: Uuid,
    pub(super) dept_a1: Uuid,
}

pub(super) fn tree() -> Tree {
    Tree {
        org: OrgId::from_uuid(Uuid::new_v4()),
        le_a: Uuid::new_v4(),
        le_b: Uuid::new_v4(),
        wp_a1: Uuid::new_v4(),
        dept_a1: Uuid::new_v4(),
    }
}

pub(super) fn n(kind: NodeKind, id: Uuid) -> NodeRef {
    NodeRef { kind, id }
}

impl Tree {
    pub(super) fn tenant(&self) -> NodePath {
        NodePath::tenant(self.org)
    }
    pub(super) fn le(&self, id: Uuid) -> NodePath {
        NodePath(vec![
            n(NodeKind::LegalEntity, id),
            n(NodeKind::Tenant, *self.org.as_uuid()),
        ])
    }
    pub(super) fn wp_a1(&self) -> NodePath {
        let mut p = self.le(self.le_a).0;
        p.insert(0, n(NodeKind::Workplace, self.wp_a1));
        NodePath(p)
    }
    pub(super) fn dept_a1(&self) -> NodePath {
        let mut p = self.wp_a1().0;
        p.insert(0, n(NodeKind::Department, self.dept_a1));
        NodePath(p)
    }
}

pub(super) fn line(domain: Domain, levels: &[Level]) -> RoleLine {
    RoleLine {
        domain,
        levels: normalize_levels(domain, levels).expect("offered"),
    }
}

pub(super) fn grant(scope: NodePath, lines: Vec<RoleLine>, branches: BranchScope) -> HeldGrant {
    HeldGrant {
        grant_id: Uuid::new_v4(),
        role_id: Uuid::new_v4(),
        role_version: 1,
        lines,
        scope,
        branches,
    }
}

pub(super) fn subject(t: &Tree, is_ops: bool, grants: Vec<HeldGrant>) -> AccessSubject {
    AccessSubject {
        org: t.org,
        account: Uuid::new_v4(),
        is_ops,
        phase: TenantPhase::Operating,
        grants,
    }
}

fn allows(slice: &AccessSlice, action: &str, at: &NodePath) -> bool {
    slice.allows(action, at).expect("decides")
}

#[test]
fn the_schema_validates_and_names_every_offered_group() {
    let src = schema_source();
    assert!(src.contains("action \"hr_basic::edit\""));
    assert!(src.contains("action \"employee_directory_manage\" in [\"hr_basic::edit\"]"));
    assert!(
        !src.contains("work_order_create"),
        "fenced keys stay out of the schema"
    );
    AccessSlice::compile(&subject(&tree(), false, vec![])).expect("empty slice compiles");
}

#[test]
fn a_legal_entity_grant_reaches_its_subtree_and_nothing_else() {
    let t = tree();
    let g = grant(
        t.le(t.le_a),
        vec![line(Domain::HrBasic, &[Level::Edit])],
        BranchScope::All,
    );
    let slice = AccessSlice::compile(&subject(&t, false, vec![g])).expect("compiles");
    let edit = Feature::EmployeeDirectoryManage.as_str();
    assert!(allows(&slice, edit, &t.le(t.le_a)));
    assert!(allows(&slice, edit, &t.wp_a1()));
    assert!(
        allows(&slice, edit, &t.dept_a1()),
        "부서 under the 법인 is inside the subtree"
    );
    assert!(!allows(&slice, edit, &t.le(t.le_b)), "another 법인");
    assert!(
        !allows(&slice, edit, &t.tenant()),
        "the whole tenant is above the grant"
    );
    // edit implied view; other domains and levels stay closed.
    assert!(allows(
        &slice,
        Feature::EmployeeDirectoryRead.as_str(),
        &t.le(t.le_a)
    ));
    assert!(allows(
        &slice,
        &action_group(Domain::HrBasic, Level::View),
        &t.wp_a1()
    ));
    assert!(!allows(
        &slice,
        &action_group(Domain::HrBasic, Level::Approve),
        &t.le(t.le_a)
    ));
    assert!(!allows(
        &slice,
        Feature::PayrollRunRead.as_str(),
        &t.le(t.le_a)
    ));
    assert!(!allows(
        &slice,
        &action_group(Domain::Access, Level::Edit),
        &t.le(t.le_a)
    ));
}

#[test]
fn a_view_only_line_never_edits_and_a_workplace_grant_stays_in_its_workplace() {
    let t = tree();
    let g = grant(
        t.wp_a1(),
        vec![line(Domain::Org, &[Level::View])],
        BranchScope::All,
    );
    let slice = AccessSlice::compile(&subject(&t, false, vec![g])).expect("compiles");
    assert!(allows(&slice, Feature::OrgChangeRead.as_str(), &t.wp_a1()));
    assert!(allows(
        &slice,
        Feature::OrgChangeRead.as_str(),
        &t.dept_a1()
    ));
    assert!(!allows(
        &slice,
        Feature::OrgChangeDraft.as_str(),
        &t.wp_a1()
    ));
    assert!(!allows(
        &slice,
        Feature::OrgChangeRead.as_str(),
        &t.le(t.le_a)
    ));
}

#[test]
fn a_tenant_grant_reaches_every_node_and_several_grants_add_up() {
    let t = tree();
    let wide = grant(
        t.tenant(),
        vec![line(Domain::Org, &[Level::View])],
        BranchScope::All,
    );
    let narrow = grant(
        t.le(t.le_b),
        vec![line(Domain::Pay, &[Level::Export])],
        BranchScope::All,
    );
    let slice = AccessSlice::compile(&subject(&t, false, vec![wide, narrow])).expect("compiles");
    for at in [
        t.tenant(),
        t.le(t.le_a),
        t.le(t.le_b),
        t.wp_a1(),
        t.dept_a1(),
    ] {
        assert!(allows(&slice, Feature::OrgChangeRead.as_str(), &at));
    }
    assert!(allows(
        &slice,
        &action_group(Domain::Pay, Level::Export),
        &t.le(t.le_b)
    ));
    assert!(
        allows(&slice, Feature::PayrollRunRead.as_str(), &t.le(t.le_b)),
        "export implies view"
    );
    assert!(!allows(
        &slice,
        Feature::PayrollRunRead.as_str(),
        &t.le(t.le_a)
    ));
}

#[test]
fn no_grant_is_default_deny_and_ops_is_break_glass() {
    let t = tree();
    let none = AccessSlice::compile(&subject(&t, false, vec![])).expect("compiles");
    let ops = AccessSlice::compile(&subject(&t, true, vec![])).expect("compiles");
    for action in [
        Feature::EmployeeDirectoryRead.as_str().to_owned(),
        action_group(Domain::Access, Level::Edit),
        action_group(Domain::Tenant, Level::Approve),
    ] {
        assert!(!allows(&none, &action, &t.tenant()));
        assert!(allows(&ops, &action, &t.tenant()));
        assert!(allows(&ops, &action, &t.dept_a1()));
    }
}

#[cfg(test)]
mod platform_validation {
    use super::*;

    #[test]
    fn a_validated_platform_slice_does_not_skip_validation_of_tenant_grants() {
        let t = tree();
        AccessSlice::compile(&subject(&t, true, vec![])).expect("platform policies validate");
        let invalid = grant(
            t.tenant(),
            vec![RoleLine {
                domain: Domain::Sensitive,
                levels: vec![Level::Approve],
            }],
            BranchScope::All,
        );
        assert!(matches!(
            AccessSlice::compile(&subject(&t, false, vec![invalid])),
            Err(AccessEngineError::Compile(_))
        ));
        let none = AccessSlice::compile(&subject(&t, false, vec![])).expect("fresh account");
        assert!(!allows(
            &none,
            Feature::EmployeeDirectoryRead.as_str(),
            &t.tenant()
        ));
    }
}

#[test]
fn an_incomplete_or_foreign_chain_is_an_error_never_an_allow() {
    let t = tree();
    let g = grant(
        t.tenant(),
        vec![line(Domain::Org, &[Level::View])],
        BranchScope::All,
    );
    let slice = AccessSlice::compile(&subject(&t, false, vec![g])).expect("compiles");
    let orphan = NodePath(vec![n(NodeKind::Workplace, t.wp_a1)]);
    assert!(matches!(
        slice.allows(Feature::OrgChangeRead.as_str(), &orphan),
        Err(AccessEngineError::FactMissing(_))
    ));
    let other = tree();
    assert!(
        slice
            .allows(Feature::OrgChangeRead.as_str(), &other.le(other.le_a))
            .is_err()
    );
    // A workplace whose 법인 link is missing (a voided 사업장) is not a tenant-wide node.
    let broken = NodePath(vec![
        n(NodeKind::Workplace, t.wp_a1),
        n(NodeKind::Tenant, *t.org.as_uuid()),
    ]);
    assert!(
        slice
            .allows(Feature::OrgChangeRead.as_str(), &broken)
            .is_err()
    );
    // An unknown action is refused, not allowed.
    assert!(slice.allows("work_order_create", &t.tenant()).is_err());
}
