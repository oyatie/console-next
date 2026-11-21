// SPDX-License-Identifier: LicenseRef-Proprietary
//! `GET /api/v1/hr/exit-cases/counts`: single-scan status counts respecting branch scope.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, QueryBuilder, Row};

use crate::authz::authorize_hr_scoped;
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::exits::queries::ExitCaseFilters;
use crate::metrics::record_hr_read;
use crate::{HrError, HrService};

#[derive(Debug, Default, Deserialize)]
pub struct ExitCaseCountsQuery {
    pub search: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ExitCaseCountsResponse {
    pub all: i64,
    pub open: i64,
    pub closed: i64,
    pub reported: i64,
    pub hr_confirmed: i64,
    pub hq_confirmed: i64,
    pub settlement_ready: i64,
    pub approval_drafted: i64,
    pub submitted: i64,
    pub rejected: i64,
    pub cancelled: i64,
}

impl HrService {
    pub async fn exit_case_counts(
        &self,
        principal: Principal,
        query: ExitCaseCountsQuery,
    ) -> Result<ExitCaseCountsResponse, HrError> {
        authorize_hr_scoped(&principal, Feature::EmployeeDirectoryRead)?;
        record_hr_read("exit_cases");
        let scope = principal.branch_scope.clone();
        let filters = ExitCaseFilters {
            search: query
                .search
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            ..ExitCaseFilters::default()
        };
        let reader = principal.clone();
        with_audits::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let mut q = QueryBuilder::<Postgres>::new(
                    "SELECT COUNT(*) AS all_count, \
                     COUNT(*) FILTER (WHERE c.status IN ('REPORTED','HR_CONFIRMED','HQ_CONFIRMED','SETTLEMENT_READY','APPROVAL_DRAFTED')) AS open_count, \
                     COUNT(*) FILTER (WHERE c.status IN ('SUBMITTED','REJECTED','CANCELLED')) AS closed_count, \
                     COUNT(*) FILTER (WHERE c.status = 'REPORTED') AS reported_count, \
                     COUNT(*) FILTER (WHERE c.status = 'HR_CONFIRMED') AS hr_confirmed_count, \
                     COUNT(*) FILTER (WHERE c.status = 'HQ_CONFIRMED') AS hq_confirmed_count, \
                     COUNT(*) FILTER (WHERE c.status = 'SETTLEMENT_READY') AS settlement_ready_count, \
                     COUNT(*) FILTER (WHERE c.status = 'APPROVAL_DRAFTED') AS approval_drafted_count, \
                     COUNT(*) FILTER (WHERE c.status = 'SUBMITTED') AS submitted_count, \
                     COUNT(*) FILTER (WHERE c.status = 'REJECTED') AS rejected_count, \
                     COUNT(*) FILTER (WHERE c.status = 'CANCELLED') AS cancelled_count \
                     FROM employee_exit_cases c",
                );
                filters.push(&mut q, &scope);
                let row = q.build().fetch_one(tx.as_mut()).await?;
                let counts = ExitCaseCountsResponse {
                    all: row.try_get("all_count")?,
                    open: row.try_get("open_count")?,
                    closed: row.try_get("closed_count")?,
                    reported: row.try_get("reported_count")?,
                    hr_confirmed: row.try_get("hr_confirmed_count")?,
                    hq_confirmed: row.try_get("hq_confirmed_count")?,
                    settlement_ready: row.try_get("settlement_ready_count")?,
                    approval_drafted: row.try_get("approval_drafted_count")?,
                    submitted: row.try_get("submitted_count")?,
                    rejected: row.try_get("rejected_count")?,
                    cancelled: row.try_get("cancelled_count")?,
                };
                let me = actor_employee_id(tx, &reader).await?;
                let event = access_event(
                    &reader,
                    DirectoryAccess::ExitCaseList,
                    &[],
                    me,
                    json!({ "view": "exit_case_counts" }),
                )?;
                Ok((counts, vec![event]))
            })
        })
        .await
    }
}
