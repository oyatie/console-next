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
    pub fn node(&self, org: OrgId) -> NodeRef {
        for (kind, _) in PLACEMENT {
            let id = match kind {
                NodeKind::Department => self.org_unit_id,
                NodeKind::Workplace => self.workplace_id,
                NodeKind::LegalEntity => self.legal_entity_id,
                NodeKind::Tenant => None,
            };
            if let Some(id) = id {
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
pub struct EmployeeVisibility(Vec<String>);

impl EmployeeVisibility {
    /// Compose with the armed tenant floor. Requires the directory's `e` and `ea` aliases.
    pub fn push(&self, query: &mut QueryBuilder<Postgres>) {
        query.push("(CASE");
        for (kind, column) in PLACEMENT {
            query.push(format!(
                " WHEN {column} IS NOT NULL THEN '{}:' || {column}::text",
                kind.as_str()
            ));
        }
        query.push(" ELSE 'TENANT:' || e.org_id::text END = ANY(");
        query.push_bind(self.0.clone());
        query.push("))");
    }
}

impl DecisionFacts {
    /// Enumerate permitted nodes, never grants; unknown and dissolved placements stay hidden.
    ///
    /// # Errors
    /// A Cedar evaluation failure.
    pub fn visible_employees(&self, action: &str) -> Result<EmployeeVisibility, AccessEngineError> {
        let mut nodes = Vec::new();
        for node in self.paths.keys() {
            if self.authorize(action, *node)? {
                nodes.push(format!("{}:{}", node.kind.as_str(), node.id));
            }
        }
        Ok(EmployeeVisibility(nodes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn employee_node_uses_the_most_specific_placement_including_tenant_fallback() {
        let org = OrgId::new();
        let department = Uuid::new_v4();
        let workplace = Uuid::new_v4();
        let entity = Uuid::new_v4();
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
                .node(org),
                NodeRef { kind, id }
            );
        }
    }
}
