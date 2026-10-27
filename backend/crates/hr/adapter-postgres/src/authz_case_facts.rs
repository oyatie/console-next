// SPDX-License-Identifier: LicenseRef-Proprietary
//! Resource facts for the exit gate, shared by point actions and bounded inbox pages.
use std::collections::BTreeMap;

use console_kernel_core::OrgId;
use console_platform_authz::{
    Feature,
    access::{NodeKind, NodeRef},
    cedar_pbac::visible::DecisionFacts,
};
use serde::Deserialize;
use sqlx::{Postgres, Transaction, types::Json};
use uuid::Uuid;

use crate::{
    HrError,
    authz::{HrReach, HrScope},
};

// Keep the existing HR reach traversal bound.
const MAX_SCOPE_DEPTH: u8 = 64;

#[derive(Default, Deserialize)]
pub struct HrCaseFacts {
    people: BTreeMap<Uuid, Place>,
    units: BTreeMap<Uuid, Unit>,
}

#[derive(Deserialize)]
struct Place {
    legal_entity_id: Option<Uuid>,
    workplace_id: Option<Uuid>,
    org_unit_id: Option<Uuid>,
    own: bool,
}

#[derive(Deserialize)]
struct Unit {
    parent: Option<Uuid>,
    placed: bool,
    revised: bool,
    legal_entity_id: Option<Uuid>,
    workplace_id: Option<Uuid>,
}

impl HrCaseFacts {
    /// One statement loads the page's assignments and the tenant's department hierarchy.
    pub async fn load(
        tx: &mut Transaction<'_, Postgres>,
        actor: Uuid,
        ids: &[Uuid],
    ) -> Result<Self, HrError> {
        let Json(facts) = sqlx::query_scalar(
            "WITH people AS MATERIALIZED (SELECT e.id,e.org_unit_id,ea.legal_entity_id,ea.workplace_id, \
             COALESCE(e.id=u.employee_id OR s.person_id=m.person_id OR s.person_id=u.employee_id,false) AS own \
             FROM person_employees_current e LEFT JOIN employment_resolved_assignments ea \
               ON ea.org_id=e.org_id AND ea.employee_id=e.id \
             LEFT JOIN users u ON u.org_id=e.org_id AND u.id=$2 \
             LEFT JOIN employee_person_bindings s ON s.org_id=e.org_id AND s.employee_id=e.id \
             LEFT JOIN employee_person_bindings m ON m.org_id=u.org_id AND m.employee_id=u.employee_id WHERE e.id=ANY($1)), \
             heads AS MATERIALIZED (SELECT DISTINCT ON (org_unit_id) org_unit_id,attributes->>'parent_id' AS parent \
               FROM org_unit_revisions ORDER BY org_unit_id,version DESC), \
             units AS (SELECT u.id AS org_unit_id,h.parent,p.org_unit_id IS NOT NULL AS placed,h.org_unit_id IS NOT NULL AS revised,p.legal_entity_id,p.workplace_id \
               FROM org_units u LEFT JOIN heads h ON h.org_unit_id=u.id \
               LEFT JOIN org_unit_placements p ON p.org_id=u.org_id AND p.org_unit_id=u.id AND p.valid_to IS NULL) \
             SELECT jsonb_build_object('people',COALESCE((SELECT jsonb_object_agg(id,to_jsonb(people)) FROM people),'{}'), \
               'units',COALESCE((SELECT jsonb_object_agg(org_unit_id,to_jsonb(units)) FROM units),'{}'))"
        ).bind(ids).bind(actor).fetch_one(tx.as_mut()).await?;
        Ok(facts)
    }

    pub fn is_own(&self, employee: Uuid) -> bool {
        self.people.get(&employee).is_some_and(|p| p.own)
    }

    /// Cedar remains the authority for disclosing an employee's name and links.
    pub fn readable(
        &self,
        facts: &DecisionFacts,
        org: OrgId,
        employee: Uuid,
    ) -> Result<bool, HrError> {
        let Some(p) = self.people.get(&employee) else {
            return Ok(false);
        };
        let (kind, id) = match (p.org_unit_id, p.workplace_id, p.legal_entity_id) {
            (Some(id), _, _) => (NodeKind::Department, id),
            (_, Some(id), _) => (NodeKind::Workplace, id),
            (_, _, Some(id)) => (NodeKind::LegalEntity, id),
            _ => (NodeKind::Tenant, *org.as_uuid()),
        };
        facts
            .authorize(
                Feature::EmployeeDirectoryRead.as_str(),
                NodeRef { kind, id },
            )
            .map_err(|e| HrError::internal(format!("exit scope facts unavailable: {e}")))
    }

    pub(super) fn contains(&self, reach: &HrReach, employee: Uuid) -> bool {
        let scope = match reach {
            HrReach::All => return true,
            HrReach::Within { scope, .. } => scope,
        };
        let Some(p) = self.people.get(&employee) else {
            return false;
        };
        if in_place(scope, p.legal_entity_id, p.workplace_id) {
            return true;
        }
        let mut unit = p.org_unit_id;
        let mut placement_open = p.legal_entity_id.is_none() && p.workplace_id.is_none();
        for _ in 0..=MAX_SCOPE_DEPTH {
            let Some((id, facts)) = unit.and_then(|id| self.units.get(&id).map(|f| (id, f))) else {
                break;
            };
            if facts.revised && scope.units.contains(&id) {
                return true;
            }
            if placement_open && facts.placed {
                if in_place(scope, facts.legal_entity_id, facts.workplace_id) {
                    return true;
                }
                placement_open = false;
            }
            unit = facts.parent;
        }
        false
    }
}

fn in_place(scope: &HrScope, entity: Option<Uuid>, workplace: Option<Uuid>) -> bool {
    entity.is_some_and(|id| scope.entities.contains(&id))
        || workplace.is_some_and(|id| scope.workplaces.contains(&id))
}
