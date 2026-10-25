// SPDX-License-Identifier: LicenseRef-Proprietary
//! F5 수습 종료: HR records that the probation ended (본채용 확정). A command
//! (ME-7): the body asserts the end date it was shown; a changed date is a
//! 409 `stale_facts`. A repeat on a confirmed probation replays the record.

use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_ontology_canonical_adapter_postgres::employee_facts::touch_employee;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use console_platform_preconditions::{Fact, check_expected};
use serde::Deserialize;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::patch::{provenance, refusal_error};
use super::read::{EmploymentFacts, load_facts};
use crate::authz::{authorize_hr_person, hr_reach};
use crate::{HrError, HrService};

#[derive(Debug, Deserialize)]
pub struct ConfirmProbationRequest {
    pub expected: Vec<Fact>,
}

const REQUIRED_FACTS: [&str; 1] = ["/employment/probation_end_date"];

impl HrService {
    pub async fn confirm_probation(
        &self,
        principal: Principal,
        employee_id: Uuid,
        request: ConfirmProbationRequest,
    ) -> Result<EmploymentFacts, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let actor = principal.user_id;
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(
                    tx,
                    &principal,
                    Feature::EmployeeDirectoryManage,
                    employee_id,
                )
                .await?;
                crate::employee_state::require_editable(tx.as_mut(), org_uuid, employee_id).await?;
                let current = load_facts(tx, org_uuid, employee_id, true).await?;
                let doc =
                    serde_json::to_value(&current).map_err(|e| HrError::internal(e.to_string()))?;
                check_expected(
                    &request.expected,
                    &REQUIRED_FACTS,
                    &doc,
                    &provenance(&current),
                    |_| true,
                )
                .map_err(|refusal| refusal_error(&refusal))?;
                let employment = current.employment.as_ref().ok_or_else(|| {
                    HrError::from_kernel(KernelError::conflict(
                        "the employee has no employment profile; register the employment first",
                    ))
                })?;
                if employment.probation_confirmed_at.is_some() {
                    return Ok((current, Vec::new()));
                }
                if employment.probation_end_date.is_none() {
                    return Err(HrError::from_kernel(KernelError::invalid_transition(
                        "no probation is recorded for this employee",
                    )));
                }
                sqlx::query(
                    "UPDATE employee_employment_profiles SET probation_confirmed_at = now(), \
                     probation_confirmed_by = $3 WHERE org_id = $1 AND employee_id = $2",
                )
                .bind(org_uuid)
                .bind(employee_id)
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await?;
                touch_employee(tx, org_uuid, employee_id).await?;
                let after = load_facts(tx, org_uuid, employee_id, false).await?;
                let audit = AuditEvent::new(
                    Some(actor),
                    AuditAction::new("employee.probation.confirm").map_err(HrError::from_kernel)?,
                    "employee",
                    employee_id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({ "probation_end_date": &employment.probation_end_date })),
                );
                Ok((after, vec![audit]))
            })
        })
        .await
    }
}
