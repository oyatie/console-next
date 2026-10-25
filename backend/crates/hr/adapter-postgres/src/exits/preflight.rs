// SPDX-License-Identifier: LicenseRef-Proprietary
//! Read the same statutory inputs as confirmation, without locking or changing the employee.
use super::{
    guards::{ProtectedPeriodView, load_protected_periods, termination_date},
    notice_pay::{NoticePay, notice_pay},
};
use crate::{HrError, HrService};
use console_hr_application::lifecycle::hooks::{TerminationFacts, terminate_may_apply};
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use console_settings_adapter_postgres::validate_reason_in_tx;
use console_settings_domain::code_lists::ReasonDomain;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct ExitGuardsQuery {
    pub effective_exit_date: String,
    pub exit_reason_code: Option<String>,
    pub dismissal_notice_served_on: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct ExitGuardsView {
    pub protected_periods: Vec<ProtectedPeriodView>,
    pub protection_rules: Vec<crate::legal_rules::LeaveProtectionRule>,
    pub notice_required: bool,
    pub refusal_code: Option<&'static str>,
    pub notice_pay: Option<NoticePay>,
}
impl HrService {
    pub async fn employee_exit_guards(
        &self,
        principal: Principal,
        employee: Uuid,
        query: ExitGuardsQuery,
    ) -> Result<ExitGuardsView, HrError> {
        let org = principal.org_id;
        let date = termination_date(&query.effective_exit_date)?;
        with_audits::<_, _, HrError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let branch: Option<Uuid> = sqlx::query_scalar(
                    "SELECT home_branch_id FROM employees WHERE org_id=$1 AND id=$2",
                )
                .bind(org.as_uuid())
                .bind(employee)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| {
                    HrError::from_kernel(KernelError::not_found("employee not found"))
                })?;
                if crate::authz::authorize_hr_case(
                    tx,
                    &principal,
                    Feature::ExitCaseReport,
                    branch,
                    employee,
                )
                .await
                .is_err()
                {
                    crate::authz::authorize_hr_case(
                        tx,
                        &principal,
                        Feature::ExitCaseHrConfirm,
                        branch,
                        employee,
                    )
                    .await?;
                }
                let class = if let Some(code) = query.exit_reason_code.as_deref() {
                    Some(
                        validate_reason_in_tx(
                            tx.as_mut(),
                            org,
                            ReasonDomain::ExitReason,
                            code,
                            Some("preflight"),
                        )
                        .await
                        .map_err(crate::lifecycle::title_reason::coded)?,
                    )
                } else {
                    None
                };
                let periods =
                    load_protected_periods(tx.as_mut(), *org.as_uuid(), employee, date).await?;
                let blocking = super::guards::protection_views(tx.as_mut(), &periods, date).await?;
                let notice_required = class.as_ref().is_some_and(|c| c.notice_required);
                let facts = TerminationFacts {
                    involuntary: class.as_ref().is_some_and(|c| c.involuntary),
                    notice_required: false,
                    notice: None,
                    protected_periods: &periods,
                    termination_date: date,
                };
                let mut refusal_code = terminate_may_apply(Some(&facts)).err().and_then(|e| e.code);
                let notice_pay = if notice_required {
                    Some(
                        notice_pay(
                            tx.as_mut(),
                            *org.as_uuid(),
                            employee,
                            &query.effective_exit_date,
                            query.dismissal_notice_served_on.as_deref(),
                            None,
                            None,
                        )
                        .await?,
                    )
                } else {
                    None
                };
                if refusal_code.is_none()
                    && query.dismissal_notice_served_on.is_some()
                    && notice_pay.as_ref().is_some_and(|pay| !pay.accepts(None))
                {
                    refusal_code = Some("dismissal_notice_short");
                }
                let me = crate::directory::access_log::actor_employee_id(tx, &principal).await?;
                let event = crate::directory::access_log::access_event(
                    &principal,
                    crate::directory::access_log::DirectoryAccess::Detail,
                    &[employee],
                    me,
                    json!({"view":"exit_guards"}),
                )?;
                let protection_rules = crate::legal_rules::leave_rules(tx.as_mut(), date).await?;
                Ok((
                    ExitGuardsView {
                        protection_rules,
                        protected_periods: blocking,
                        notice_required,
                        refusal_code,
                        notice_pay,
                    },
                    vec![event],
                ))
            })
        })
        .await
    }
}
