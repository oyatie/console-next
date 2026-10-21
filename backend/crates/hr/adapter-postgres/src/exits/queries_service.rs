//! HrService exit-case reads.
//! Handler body moved verbatim from `app/src/hr.rs` (R2-exits).

use console_compliance_domain::statutory::StatutoryRegister;
use console_hr_domain::exits::case::EXIT_CASE_STATUSES;
use console_hr_domain::text::normalize_enum_text;
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde_json::json;
use uuid::Uuid;

use crate::authz::authorize_hr_scoped;
use crate::directory::access_log::{
    DirectoryAccess, access_event, access_event_on, actor_employee_id,
};
use crate::exits::deadlines::settlement_deadlines;
use crate::exits::queries::{ExitCaseFilters, count_filtered_exit_cases, load_exit_cases};
use crate::exits::types::{EmployeeExitCasePage, EmployeeExitCaseResponse, ExitCaseListQuery};
use crate::metrics::record_hr_read;
use crate::{HrError, HrService};

impl HrService {
    /// `GET /api/v1/hr/exit-cases?employee_id=&status=&limit=&offset=`: exit cases
    /// inside the caller's branch scope, newest activity first, with the filtered
    /// `total`. Same read gate as the absence/exit dashboard.
    pub async fn list_exit_cases(
        &self,
        principal: Principal,
        query: ExitCaseListQuery,
    ) -> Result<EmployeeExitCasePage, HrError> {
        authorize_hr_scoped(&principal, Feature::EmployeeDirectoryRead)?;
        record_hr_read("exit_cases");
        let scope = principal.branch_scope.clone();
        let limit = query.limit.unwrap_or(50).clamp(1, 200);
        let offset = query.offset.unwrap_or(0).max(0);
        let statuses = query
            .status
            .as_deref()
            .unwrap_or_default()
            .split(',')
            .map(|part| normalize_enum_text(part.to_owned()))
            .filter(|part| !part.is_empty())
            .map(|part| {
                if EXIT_CASE_STATUSES.contains(&part.as_str()) {
                    Ok(part)
                } else {
                    Err(HrError::validation("unknown status filter"))
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        let filters = ExitCaseFilters {
            employee_id: query.employee_id,
            case_id: None,
            statuses,
            search: query
                .search
                .as_deref()
                .map(str::trim)
                .filter(|search| !search.is_empty())
                .map(str::to_owned),
        };
        let reader = principal.clone();
        let (items, total) =
            with_audits::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
                Box::pin(async move {
                    let total = count_filtered_exit_cases(tx, &scope, &filters).await?;
                    let items = load_exit_cases(tx, &scope, &filters, limit, offset).await?;
                    let subjects: Vec<Uuid> = items.iter().map(|item| item.employee_id).collect();
                    let me = actor_employee_id(tx, &reader).await?;
                    let event = access_event(
                        &reader,
                        DirectoryAccess::ExitCaseList,
                        &subjects,
                        me,
                        json!({ "case_ids": items.iter().map(|item| item.id).collect::<Vec<_>>() }),
                    )?;
                    Ok(((items, total), vec![event]))
                })
            })
            .await?;
        Ok(EmployeeExitCasePage {
            items: items
                .into_iter()
                .map(|item| item.for_reader(&principal))
                .collect(),
            total,
            limit,
            offset,
        })
    }

    /// `GET /api/v1/hr/exit-cases/{id}`: one case; outside the caller's branch
    /// scope it is 404 like an absent one (deny by omission).
    pub async fn exit_case(
        &self,
        principal: Principal,
        case_id: Uuid,
        register: &StatutoryRegister,
    ) -> Result<EmployeeExitCaseResponse, HrError> {
        authorize_hr_scoped(&principal, Feature::EmployeeDirectoryRead)?;
        record_hr_read("exit_case");
        let scope = principal.branch_scope.clone();
        let reader = principal.clone();
        let item = with_audits::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let filters = ExitCaseFilters {
                    case_id: Some(case_id),
                    ..ExitCaseFilters::default()
                };
                let item = load_exit_cases(tx, &scope, &filters, 1, 0)
                    .await?
                    .pop()
                    .ok_or_else(|| {
                        HrError::from_kernel(KernelError::not_found("exit case not found"))
                    })?;
                let me = actor_employee_id(tx, &reader).await?;
                let event = access_event_on(
                    &reader,
                    DirectoryAccess::ExitCase,
                    case_id.to_string(),
                    &[item.employee_id],
                    me,
                    json!({}),
                )?;
                Ok((item, vec![event]))
            })
        })
        .await?;
        let mut item = item.for_reader(&principal);
        item.settlement_deadlines =
            Some(settlement_deadlines(&item.effective_exit_date, register)?);
        Ok(item)
    }
}
