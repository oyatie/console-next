//! The pilot bridge to the existing doors: every operation key Cedar allows a
//! held grant on its own scope node becomes an [`EffectiveFeatureGrant`] over
//! the branches that node covers, and the principal's branch scope widens by
//! the same branches. The doors keep their branch checks, so a grant reaches
//! exactly its 법인 / 사업장 (or the tenant). AX-5: the same decisions are
//! also kept per scope node ([`Projection::scoped`]); the HR doors decide per
//! resource over those, so a 법인, 사업장 or 부서 grant reaches its people
//! whatever their legacy branch.

use console_kernel_core::BranchScope;

use super::catalog::Domain;
use super::cedar::{AccessEngineError, AccessSlice};
use super::model::{AccessSubject, ScopeGrant, union_branches};
use super::tags::tagged;
use crate::{EffectiveFeatureGrant, Feature, PermissionLevel};

/// What a subject's grants add to its principal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Projection {
    pub grants: Vec<EffectiveFeatureGrant>,
    pub branches: BranchScope,
    /// AX-5: each operation key Cedar allowed on a grant's own node.
    pub scoped: Vec<ScopeGrant>,
    /// Engine refusals (each one denied what it touched); for the caller's log.
    pub errors: Vec<AccessEngineError>,
}

impl Projection {
    fn empty() -> Self {
        Self {
            grants: Vec::new(),
            branches: BranchScope::Branches(Default::default()),
            scoped: Vec::new(),
            errors: Vec::new(),
        }
    }
}

/// Tenant-level domains: their keys are capabilities over the whole tenant
/// (who may grant, read the audit trail, change settings), not rows in a
/// branch. A grant in one of them never moves the branch scope the data doors
/// filter by — otherwise a 회사 전체 권한 관리 grant turned a 법인-scoped
/// 인사 grant's holder into an all-branch principal that the org-wide HR
/// gate then refused (governance-02).
const fn moves_data_scope(domain: Domain) -> bool {
    !matches!(
        domain,
        Domain::Access
            | Domain::Audit
            | Domain::Settings
            | Domain::Retention
            | Domain::Tenant
            | Domain::SupportAccess
    )
}

/// Project `subject`'s held grants. The ops account projects nothing: its
/// break-glass access is the platform policy, not a grant.
///
/// The principal's branch scope widens by the data-domain grants only; a
/// subject holding nothing but tenant-level grants widens by those, so it
/// keeps a scope to act in.
// one scalar branch scope per principal; a TENANT grant in an
// org-wide-gated data domain next to a narrower one still cannot satisfy both
// doors. AX-5 (Cedar at each door) removes the scalar.
#[must_use]
pub fn project(subject: &AccessSubject) -> Projection {
    let mut out = Projection::empty();
    if subject.is_ops || subject.grants.is_empty() {
        return out;
    }
    let slice = match AccessSlice::compile(subject) {
        Ok(slice) => slice,
        Err(err) => {
            out.errors.push(err);
            return out;
        }
    };
    let mut tenant_level = BranchScope::Branches(Default::default());
    let mut any_data = false;
    for grant in &subject.grants {
        let mut any = false;
        let mut data = false;
        for (feature, domain, level) in tagged() {
            let in_line = grant
                .lines
                .iter()
                .any(|l| l.domain == domain && l.levels.contains(&level));
            if !in_line {
                continue;
            }
            match slice.allows(feature.as_str(), &grant.scope) {
                Ok(true) => {
                    any = true;
                    if let Some(node) = grant.scope.node() {
                        out.scoped.push(ScopeGrant {
                            feature,
                            kind: node.kind,
                            id: node.id,
                        });
                    }
                    data |= moves_data_scope(domain);
                    out.grants.push(EffectiveFeatureGrant::new(
                        feature,
                        PermissionLevel::Allow,
                        grant.branches.clone(),
                    ));
                }
                Ok(false) => {}
                Err(err) => out.errors.push(err),
            }
        }
        if data {
            any_data = true;
            out.branches = union_branches(&out.branches, &grant.branches);
        } else if any {
            tenant_level = union_branches(&tenant_level, &grant.branches);
        }
    }
    if !any_data {
        out.branches = tenant_level;
    }
    // Holding any grant makes the account a working member: the bare
    // tenant-membership door (`Login`, which no role line can name) opens over
    // the projected scope. Without it a roleless holder (AX-0, governance-01)
    // was refused the branch list and every other membership read.
    if !out.grants.is_empty() {
        out.grants.push(EffectiveFeatureGrant::new(
            Feature::Login,
            PermissionLevel::Allow,
            out.branches.clone(),
        ));
    }
    out
}
