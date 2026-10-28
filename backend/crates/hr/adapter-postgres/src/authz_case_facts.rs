// SPDX-License-Identifier: LicenseRef-Proprietary
//! Resource facts for the exit gate, shared by point actions and bounded inbox pages.
use std::collections::BTreeMap;

use console_kernel_core::OrgId;
use console_platform_authz::{
    Feature,
    cedar_pbac::visible::{DecisionFacts, EmployeePlacement},
};
use serde::Deserialize;
use sqlx::{Postgres, Transaction, types::Json};
use uuid::Uuid;

use crate::HrError;

#[derive(Default, Deserialize)]
pub struct HrCaseFacts {
    people: BTreeMap<Uuid, Place>,
}

#[derive(Deserialize)]
struct Place {
    #[serde(flatten)]
    placement: EmployeePlacement,
    own: bool,
}

impl HrCaseFacts {
    /// One statement loads the page's placements and own-record identities.
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
             LEFT JOIN employee_person_bindings m ON m.org_id=u.org_id AND m.employee_id=u.employee_id WHERE e.id=ANY($1)) \
             SELECT jsonb_build_object('people',COALESCE((SELECT jsonb_object_agg(id,to_jsonb(people)) FROM people),'{}'))"
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
        self.permits(facts, org, employee, Feature::EmployeeDirectoryRead)
    }

    pub(super) fn permits(
        &self,
        facts: &DecisionFacts,
        org: OrgId,
        employee: Uuid,
        feature: Feature,
    ) -> Result<bool, HrError> {
        let Some(p) = self.people.get(&employee) else {
            return Ok(false);
        };
        facts
            .authorize(feature.as_str(), p.placement.node(org, facts))
            .map_err(|e| HrError::internal(format!("exit scope facts unavailable: {e}")))
    }
}
