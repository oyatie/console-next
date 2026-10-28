// SPDX-License-Identifier: LicenseRef-Proprietary
//! One placement order for employee point decisions and directory SQL.
use super::DecisionFacts;
use crate::access::{AccessEngineError, NodeKind, NodeRef};
use console_kernel_core::OrgId;
use serde::Deserialize;
use sqlx::{Postgres, QueryBuilder};
use uuid::Uuid;

const PLACEMENT: [(NodeKind, &str); 3] = [
    (NodeKind::Department, "e.org_unit_id"),
    (NodeKind::Workplace, "ea.workplace_id"),
    (NodeKind::LegalEntity, "ea.legal_entity_id"),
];

#[derive(Deserialize)]
pub struct EmployeePlacement {
    pub org_unit_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    pub legal_entity_id: Option<Uuid>,
}

impl EmployeePlacement {
    /// Most specific current placement; a wholly unplaced person belongs to the tenant.
    #[must_use]
    pub fn node(&self, org: OrgId, facts: &DecisionFacts) -> NodeRef {
        for (kind, _) in PLACEMENT {
            let id = match kind {
                NodeKind::Department => self.org_unit_id,
                NodeKind::Workplace => self.workplace_id,
                NodeKind::LegalEntity => self.legal_entity_id,
                NodeKind::Tenant => None,
            };
            if let Some(id) =
                id.filter(|id| facts.current_employee_placement(NodeRef { kind, id: *id }))
            {
                return NodeRef { kind, id };
            }
        }
        NodeRef {
            kind: NodeKind::Tenant,
            id: *org.as_uuid(),
        }
    }
}

/// Only the fact loader's Cedar decisions can construct this list filter.
#[derive(Clone)]
pub struct EmployeeVisibility {
    permitted: Option<Vec<String>>,
    current: Vec<NodeRef>,
}

impl EmployeeVisibility {
    #[must_use]
    pub fn reads_assignment(&self) -> bool {
        self.permitted.is_some()
    }

    /// Compose with the armed tenant floor. Requires the directory's `e` and `ea` aliases.
    pub fn push(&self, query: &mut QueryBuilder<Postgres>) {
        let Some(permitted) = &self.permitted else {
            query.push(" TRUE ");
            return;
        };
        query.push("(CASE");
        for (kind, column) in PLACEMENT {
            let current: Vec<_> = self
                .current
                .iter()
                .filter(|n| n.kind == kind)
                .map(|n| n.id)
                .collect();
            query.push(format!(" WHEN {column} = ANY("));
            query.push_bind(current);
            query.push(format!(") THEN '{}:' || {column}::text", kind.as_str()));
        }
        query.push(" ELSE 'TENANT:' || e.org_id::text END = ANY(");
        query.push_bind(permitted.clone());
        query.push("))");
    }
}

impl DecisionFacts {
    fn current_employee_placement(&self, node: NodeRef) -> bool {
        self.paths
            .get(&node)
            .is_some_and(|p| p.0.last().is_some_and(|n| n.kind == NodeKind::Tenant))
    }

    /// Tenant permits need no node filter; scoped reads fall past non-current placements.
    ///
    /// # Errors
    /// A Cedar evaluation failure.
    pub fn visible_employees(&self, action: &str) -> Result<EmployeeVisibility, AccessEngineError> {
        let tenant = self.paths.keys().find(|n| n.kind == NodeKind::Tenant);
        if let Some(tenant) = tenant
            && self.authorize(action, *tenant)?
        {
            return Ok(EmployeeVisibility {
                permitted: None,
                current: Vec::new(),
            });
        }
        let mut nodes = Vec::new();
        for node in self.paths.keys() {
            if self.authorize(action, *node)? {
                nodes.push(format!("{}:{}", node.kind.as_str(), node.id));
            }
        }
        Ok(EmployeeVisibility {
            permitted: Some(nodes),
            current: self
                .paths
                .keys()
                .copied()
                .filter(|n| self.current_employee_placement(*n))
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn employee_node_uses_the_most_specific_placement_including_tenant_fallback() {
        use crate::access::{AccessSlice, AccessSubject, NodePath};
        use console_kernel_core::TenantPhase;

        let org = OrgId::new();
        let department = Uuid::new_v4();
        let workplace = Uuid::new_v4();
        let entity = Uuid::new_v4();
        let tenant = NodeRef {
            kind: NodeKind::Tenant,
            id: *org.as_uuid(),
        };
        let mut facts = DecisionFacts {
            slice: AccessSlice::compile(&AccessSubject {
                org,
                account: Uuid::new_v4(),
                is_ops: false,
                phase: TenantPhase::Operating,
                grants: Vec::new(),
            })
            .unwrap(),
            paths: [
                (NodeKind::Department, department),
                (NodeKind::Workplace, workplace),
                (NodeKind::LegalEntity, entity),
            ]
            .into_iter()
            .map(|(kind, id)| {
                let node = NodeRef { kind, id };
                (node, NodePath(vec![node, tenant]))
            })
            .collect(),
            roles: Vec::new(),
        };
        for (unit, site, company, kind, id) in [
            (
                Some(department),
                Some(workplace),
                Some(entity),
                NodeKind::Department,
                department,
            ),
            (
                None,
                Some(workplace),
                Some(entity),
                NodeKind::Workplace,
                workplace,
            ),
            (None, None, Some(entity), NodeKind::LegalEntity, entity),
            (None, None, None, NodeKind::Tenant, *org.as_uuid()),
        ] {
            assert_eq!(
                EmployeePlacement {
                    org_unit_id: unit,
                    workplace_id: site,
                    legal_entity_id: company
                }
                .node(org, &facts),
                NodeRef { kind, id }
            );
        }
        let placement = EmployeePlacement {
            org_unit_id: Some(department),
            workplace_id: Some(workplace),
            legal_entity_id: Some(entity),
        };
        facts.paths.insert(
            NodeRef {
                kind: NodeKind::Department,
                id: department,
            },
            NodePath(vec![NodeRef {
                kind: NodeKind::Department,
                id: department,
            }]),
        );
        assert_eq!(
            placement.node(org, &facts),
            NodeRef {
                kind: NodeKind::Workplace,
                id: workplace
            }
        );
        facts.paths.remove(&NodeRef {
            kind: NodeKind::Workplace,
            id: workplace,
        });
        assert_eq!(
            placement.node(org, &facts),
            NodeRef {
                kind: NodeKind::LegalEntity,
                id: entity
            }
        );
        facts.paths.remove(&NodeRef {
            kind: NodeKind::LegalEntity,
            id: entity,
        });
        assert_eq!(placement.node(org, &facts), tenant);
    }
}
