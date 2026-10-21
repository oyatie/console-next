//! The pilot access model's plain data: scope nodes, role lines, grants and the
//! one rule that says whether a grant counts now (access-model §4.3, §5.5).

use console_kernel_core::{BranchScope, OrgId, TenantPhase, Timestamp};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::catalog::{Domain, Level};

/// A node of 회사 전체 → 법인 → 사업장 → 부서.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NodeKind {
    Tenant,
    LegalEntity,
    Workplace,
    Department,
}

impl NodeKind {
    /// The Cedar entity type of this kind.
    #[must_use]
    pub const fn cedar_type(self) -> &'static str {
        match self {
            Self::Tenant => "Tenant",
            Self::LegalEntity => "LegalEntity",
            Self::Workplace => "Workplace",
            Self::Department => "Dept",
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tenant => "TENANT",
            Self::LegalEntity => "LEGAL_ENTITY",
            Self::Workplace => "WORKPLACE",
            Self::Department => "DEPARTMENT",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        [
            Self::Tenant,
            Self::LegalEntity,
            Self::Workplace,
            Self::Department,
        ]
        .into_iter()
        .find(|k| k.as_str() == raw)
    }

    /// Whether the pilot can enforce a grant on this kind (with descendants).
    /// Every kind is: the HR doors decide per resource over the grant set
    /// (AX-5), so a 부서 grant reaches exactly its subtree. A 부서 grant still
    /// projects no branches, so the branch-keyed doors of other modules never
    /// widen to its 사업장.
    #[must_use]
    pub const fn enforceable_in_pilot(self) -> bool {
        true
    }
}

/// One node. For [`NodeKind::Tenant`] the id is the org id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeRef {
    pub kind: NodeKind,
    pub id: Uuid,
}

/// A node and its complete ancestor chain, nearest first, ending at the tenant
/// (GR-27: a chain that does not end at `Tenant` is refused by the engine).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodePath(pub Vec<NodeRef>);

impl NodePath {
    #[must_use]
    pub fn tenant(org: OrgId) -> Self {
        Self(vec![NodeRef {
            kind: NodeKind::Tenant,
            id: *org.as_uuid(),
        }])
    }

    #[must_use]
    pub fn node(&self) -> Option<NodeRef> {
        self.0.first().copied()
    }
}

/// One permission line of a role version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleLine {
    pub domain: Domain,
    pub levels: Vec<Level>,
}

/// A grant that counts now, with everything the engine needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldGrant {
    pub grant_id: Uuid,
    pub role_id: Uuid,
    pub role_version: i32,
    pub lines: Vec<RoleLine>,
    pub scope: NodePath,
    /// The legacy branches the scope covers (the door projection, AX-5 retires it).
    pub branches: BranchScope,
}

/// One (operation key, scope node) Cedar allowed on the grant's own node: the
/// holder may use the key on that node and everything under it (AX-5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeGrant {
    pub feature: crate::Feature,
    pub kind: NodeKind,
    pub id: Uuid,
}

/// The account a decision is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessSubject {
    pub org: OrgId,
    pub account: Uuid,
    pub is_ops: bool,
    pub phase: TenantPhase,
    pub grants: Vec<HeldGrant>,
}

/// Why a grant does or does not count now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Enforcement {
    Enforced,
    Prepared,
    Scheduled,
    Ended,
    Revoked,
    RoleInactive,
}

/// The facts of one grant row that decide its [`Enforcement`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrantState {
    pub revoked: bool,
    pub role_active: bool,
    pub valid_from: Timestamp,
    pub valid_to: Option<Timestamp>,
    pub effective_in_setup: bool,
}

impl GrantState {
    /// A grant counts when it is not revoked, its role is ACTIVE, `now` is in
    /// `[valid_from, valid_to)`, and the tenant is OPERATING or the grant is
    /// marked 「설정 단계부터 적용」.
    #[must_use]
    pub fn enforcement(&self, phase: TenantPhase, now: Timestamp) -> Enforcement {
        if self.revoked {
            Enforcement::Revoked
        } else if self.valid_to.is_some_and(|to| now >= to) {
            Enforcement::Ended
        } else if !self.role_active {
            Enforcement::RoleInactive
        } else if now < self.valid_from {
            Enforcement::Scheduled
        } else if phase == TenantPhase::Setup && !self.effective_in_setup {
            Enforcement::Prepared
        } else {
            Enforcement::Enforced
        }
    }
}

/// `a ∪ b` over branch scopes.
#[must_use]
pub fn union_branches(a: &BranchScope, b: &BranchScope) -> BranchScope {
    match (a, b) {
        (BranchScope::All, _) | (_, BranchScope::All) => BranchScope::All,
        (BranchScope::Branches(x), BranchScope::Branches(y)) => {
            BranchScope::Branches(x.union(y).copied().collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn state(valid_to: Option<Timestamp>) -> GrantState {
        GrantState {
            revoked: false,
            role_active: true,
            valid_from: datetime!(2026-10-01 00:00 UTC),
            valid_to,
            effective_in_setup: false,
        }
    }

    #[test]
    fn dates_are_half_open_and_setup_waits_for_go_live() {
        let now = datetime!(2026-10-06 00:00 UTC);
        let g = state(Some(datetime!(2026-10-07 00:00 UTC)));
        assert_eq!(
            g.enforcement(TenantPhase::Operating, now),
            Enforcement::Enforced
        );
        assert_eq!(
            g.enforcement(TenantPhase::Setup, now),
            Enforcement::Prepared
        );
        let setup_help = GrantState {
            effective_in_setup: true,
            ..g
        };
        assert_eq!(
            setup_help.enforcement(TenantPhase::Setup, now),
            Enforcement::Enforced
        );
        let at_end = datetime!(2026-10-07 00:00 UTC);
        assert_eq!(
            g.enforcement(TenantPhase::Operating, at_end),
            Enforcement::Ended
        );
        let before = datetime!(2026-09-30 23:59 UTC);
        assert_eq!(
            g.enforcement(TenantPhase::Operating, before),
            Enforcement::Scheduled
        );
        assert_eq!(
            GrantState { revoked: true, ..g }.enforcement(TenantPhase::Operating, now),
            Enforcement::Revoked
        );
        assert_eq!(
            GrantState {
                role_active: false,
                ..g
            }
            .enforcement(TenantPhase::Operating, now),
            Enforcement::RoleInactive
        );
    }
}
