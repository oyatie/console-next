// SPDX-License-Identifier: LicenseRef-Proprietary
//! `GET /api/v1/change-requests/counts`: single-scan OPEN counts per lane.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use sqlx::{Postgres, QueryBuilder, Row};

use crate::authz::{hr_reach, push_subject_in_reach};
use crate::metrics::record_hr_read;
use crate::{HrError, HrService};

#[derive(Debug, Serialize)]
pub struct ChangeRequestCountsResponse {
    pub all: i64,
    pub me: i64,
    pub role: i64,
}

impl HrService {
    pub async fn change_request_counts(
        &self,
        principal: Principal,
    ) -> Result<ChangeRequestCountsResponse, HrError> {
        record_hr_read("change_requests");
        let reach = hr_reach(&principal, Feature::EmployeeDirectoryManage).ok();
        let hr = reach.is_some();
        let me = *principal.user_id.as_uuid();
        let org = principal.org_id;

        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let mut q = QueryBuilder::<Postgres>::new(
                    "SELECT COUNT(*) AS all_count, \
                     COUNT(*) FILTER (WHERE r.assignee_user_id = ",
                );
                q.push_bind(me);
                q.push(") AS me_count, ");
                if hr {
                    q.push("COUNT(*) FILTER (WHERE r.assignee_user_id IS NULL) AS role_count ");
                } else {
                    q.push("0::bigint AS role_count ");
                }
                q.push("FROM change_requests r WHERE r.status = 'OPEN' AND (r.requested_by = ");
                q.push_bind(me);
                q.push(" OR r.assignee_user_id = ");
                q.push_bind(me);
                if let Some(reach) = &reach {
                    q.push(" OR ");
                    push_subject_in_reach(&mut q, reach, "r.");
                }
                q.push(")");
                let row = q.build().fetch_one(tx.as_mut()).await?;
                Ok(ChangeRequestCountsResponse {
                    all: row.try_get("all_count")?,
                    me: row.try_get("me_count")?,
                    role: row.try_get("role_count")?,
                })
            })
        })
        .await
    }
}
