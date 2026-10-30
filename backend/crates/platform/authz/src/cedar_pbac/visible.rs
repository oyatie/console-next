// SPDX-License-Identifier: LicenseRef-Proprietary
//! Cedar decides node membership; D1 lowers the allowed IDs to bound SQL.
//! Load once inside the caller's RLS transaction and use that snapshot for both
//! point and set decisions, counts and links. Compose the filter with the tenant
//! floor, never OR it with another predicate. No live surface switches here.

use std::collections::BTreeMap;

use console_kernel_core::{KernelError, OrgId, Timestamp};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[path = "visible_employee.rs"]
mod employee;
pub use employee::{EmployeePlacement, EmployeeVisibility};

use crate::access::{
    AccessEngineError, AccessSlice, NodeKind, NodePath, NodeRef, load_access_subject, scope_path,
};

use crate::access::load::dept_paths;

use super::authoring::Effect;
use super::residual::{
    LoweringTarget, ObjectPolicy, Predicate, PredicateValue, ResidualFilter, ResidualOp,
    SubjectAttrs, lower,
};

/// Immutable request facts. Only the loader can construct them; refresh them for
/// each decision transaction, including after a policy, grant or tree change.
#[derive(Debug)]
pub struct DecisionFacts {
    slice: AccessSlice,
    paths: BTreeMap<NodeRef, NodePath>,
    department_placements: BTreeMap<Uuid, NodePath>,
    roles: Vec<String>,
    org: OrgId,
    actor: Uuid,
    employee_id: Option<Uuid>,
}

impl DecisionFacts {
    /// The caller's employee link, resolved under the same tenant RLS snapshot.
    #[must_use]
    pub fn linked_employee_id(&self) -> Option<Uuid> {
        self.employee_id
    }

    /// Cedar self-service admission; pay grants never widen this record boundary.
    ///
    /// # Errors
    /// A Cedar compilation or evaluation failure.
    pub fn authorize_employee_self_read(&self, employee: Uuid) -> Result<bool, String> {
        super::actions::employee_self_read::decide(
            &self.actor.to_string(),
            &self.org.to_string(),
            self.employee_id == Some(employee),
        )
    }

    /// Live role facts for Cedar actions retaining legacy-role compatibility.
    #[must_use]
    pub fn roles(&self) -> &[String] {
        &self.roles
    }

    /// Cedar point decision with the same facts the visible set consumes.
    /// Unknown, dissolved and foreign nodes deny; Cedar errors never allow.
    ///
    /// # Errors
    /// An unknown action or a Cedar evaluation failure.
    pub fn authorize(&self, action: &str, resource: NodeRef) -> Result<bool, AccessEngineError> {
        let Some(path) = self.paths.get(&resource) else {
            return Ok(false);
        };
        match self.slice.allows(action, path) {
            // An incomplete/dissolved path cannot grant access to a node.
            Err(AccessEngineError::FactMissing(_)) => Ok(false),
            decision => decision,
        }
    }

    /// D1 filter on a UUID column containing this resource type's scope node.
    /// Every included node is a Cedar permit; Rust never interprets grant scope.
    /// Tenant permits still enumerate IDs, so an unknown node cannot slip in.
    ///
    /// # Errors
    /// A Cedar evaluation failure, requiring the caller to refuse the read.
    pub fn visible(
        &self,
        action: &str,
        resource_type: NodeKind,
        column: &str,
        first_bind: usize,
    ) -> Result<ResidualFilter, AccessEngineError> {
        if first_bind == 0 {
            return Ok(ResidualFilter::deny_all());
        }
        // shortcut: scope-node policies only; load record facts before admitting record-dependent actions.
        let mut ids = Vec::new();
        for node in self.paths.keys().filter(|n| n.kind == resource_type) {
            if self.authorize(action, *node)? {
                ids.push(node.id.to_string());
            }
        }
        let policies = if ids.is_empty() {
            Vec::new()
        } else {
            vec![ObjectPolicy {
                effect: Effect::Permit,
                predicates: vec![Predicate {
                    field: "id".to_owned(),
                    op: ResidualOp::In,
                    value: PredicateValue::LiteralSet(ids),
                }],
            }]
        };
        Ok(lower(
            LoweringTarget::Uuid { column },
            &SubjectAttrs::default(),
            &policies,
            first_bind,
        ))
    }
}

fn db(error: sqlx::Error) -> KernelError {
    KernelError::internal(format!("Cedar facts unavailable: {error}"))
}

/// Load the account, effective role/grant relationships and canonical org paths
/// once. Reuses the existing grant and hierarchy loaders, with no scope SQL.
///
/// # Errors
/// Refuses an unarmed/wrong tenant, a bypass-RLS connection or an inactive/missing
/// account. Database and Cedar compilation failures also fail closed.
pub async fn load_facts(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: Uuid,
) -> Result<DecisionFacts, KernelError> {
    let armed: bool = sqlx::query_scalar(
        "SELECT COALESCE(current_setting('app.current_org', true) = $1, false)
            AND row_security_active('access_grants') AND row_security_active('users')
            AND row_security_active('legal_entities') AND row_security_active('workplaces')
            AND row_security_active('org_units') AND row_security_active('employees')",
    )
    .bind(org.to_string())
    .fetch_one(tx.as_mut())
    .await
    .map_err(db)?;
    if !armed {
        return Err(KernelError::forbidden("Cedar facts require tenant RLS"));
    }
    let account: Option<(Vec<String>, Option<Uuid>)> = sqlx::query_as(
        "SELECT u.roles, e.id FROM users u
         LEFT JOIN employees e ON e.org_id = u.org_id AND e.id = u.employee_id
         WHERE u.org_id = $1 AND u.id = $2 AND u.is_active",
    )
    .bind(org.as_uuid())
    .bind(actor)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(db)?;
    let (roles, employee_id) =
        account.ok_or_else(|| KernelError::forbidden("Cedar facts require an active account"))?;
    let subject = load_access_subject(tx, org, actor, Timestamp::now_utc()).await?;
    let slice = AccessSlice::compile(&subject)
        .map_err(|e| KernelError::internal(format!("Cedar facts unavailable: {e}")))?;
    let tenant = NodePath::tenant(org);
    let mut paths = BTreeMap::from([(
        NodeRef {
            kind: NodeKind::Tenant,
            id: *org.as_uuid(),
        },
        tenant,
    )]);
    let entities: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM legal_entities WHERE org_id = $1 AND voided_at IS NULL")
            .bind(org.as_uuid())
            .fetch_all(tx.as_mut())
            .await
            .map_err(db)?;
    for id in entities {
        paths.insert(
            NodeRef {
                kind: NodeKind::LegalEntity,
                id,
            },
            scope_path(org, NodeKind::LegalEntity, Some(id), Some(id)),
        );
    }
    let workplaces: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT id, legal_entity_id FROM workplaces WHERE org_id = $1 AND voided_at IS NULL",
    )
    .bind(org.as_uuid())
    .fetch_all(tx.as_mut())
    .await
    .map_err(db)?;
    for (id, le) in workplaces {
        if !paths.contains_key(&NodeRef {
            kind: NodeKind::LegalEntity,
            id: le,
        }) {
            continue;
        }
        paths.insert(
            NodeRef {
                kind: NodeKind::Workplace,
                id,
            },
            scope_path(org, NodeKind::Workplace, Some(id), Some(le)),
        );
    }
    let mut department_placements = BTreeMap::new();
    for (id, department) in dept_paths(tx, org, None).await? {
        let path = department.current;
        if path
            .0
            .iter()
            .any(|node| node.kind == NodeKind::Workplace && !paths.contains_key(node))
        {
            continue;
        }
        paths.insert(
            NodeRef {
                kind: NodeKind::Department,
                id,
            },
            path,
        );
        if let Some(placement) = department.placement {
            department_placements.insert(id, placement);
        }
    }
    Ok(DecisionFacts {
        slice,
        paths,
        department_placements,
        roles,
        org,
        actor,
        employee_id,
    })
}

#[path = "support_facts.rs"]
mod support_facts;
pub use support_facts::load_support_session;
