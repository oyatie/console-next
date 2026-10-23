//! One predicate for incomplete statutory registers, shared by directory and inbox reads.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use sqlx::{Postgres, QueryBuilder};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::{hr_reach, push_reach};
use crate::{HrError, HrService};

/// Aliases `e` (employee) and `p` (profile). Optional notes and an explicit
/// no-career answer are complete; retired records use the exit-case reason.
#[macro_export]
macro_rules! register_review_sql {
    () => {
        "(e.birth_date IS NULL OR NULLIF(btrim(e.job), '') IS NULL \
         OR e.hire_on IS NULL \
         OR (COALESCE(p.employment_type = 'CONTRACT', false) AND p.contract_end_date IS NULL) \
         OR NOT EXISTS (SELECT 1 FROM employee_register_facts rf \
             WHERE rf.org_id = e.org_id AND rf.employee_id = e.id \
               AND rf.sex IS NOT NULL AND rf.address_id IS NOT NULL \
               AND rf.career_none IS NOT NULL))"
    };
}

pub struct RegisterReviewInboxPage {
    pub items: Vec<(Uuid, String, OffsetDateTime)>,
    pub total: i64,
    pub has_more: bool,
}

impl HrService {
    /// Only records the caller can complete; source denial contributes no names or counts.
    pub async fn register_review_inbox_page(
        &self,
        principal: &Principal,
        as_of: OffsetDateTime,
        after: Option<(OffsetDateTime, String)>,
        limit: usize,
    ) -> Result<RegisterReviewInboxPage, HrError> {
        let Ok(reach) = hr_reach(principal, Feature::EmployeeDirectoryManage) else {
            return Ok(RegisterReviewInboxPage {
                items: Vec::new(),
                total: 0,
                has_more: false,
            });
        };
        let org = principal.org_id;
        let limit = limit.clamp(1, 200);
        let push_where = move |q: &mut QueryBuilder<Postgres>| {
            q.push(concat!(
                " FROM person_employees_current e ",
                crate::assignment_lateral!(),
                " LEFT JOIN employee_employment_profiles p ",
                "ON p.org_id = e.org_id AND p.employee_id = e.id WHERE e.org_id = "
            ));
            q.push_bind(*org.as_uuid());
            q.push(" AND e.created_at <= ").push_bind(as_of);
            q.push(" AND e.employment_status <> 'VOIDED' AND ");
            q.push(crate::register_review_sql!()).push(" AND ");
            push_reach(q, &reach);
        };
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let mut count = QueryBuilder::<Postgres>::new("SELECT count(*)");
                push_where(&mut count);
                let total = count.build_query_scalar().fetch_one(tx.as_mut()).await?;
                let mut q = QueryBuilder::<Postgres>::new("SELECT e.id, e.name, e.created_at");
                push_where(&mut q);
                if let Some((created_at, id)) = after {
                    q.push(" AND (e.created_at, ('hr_register:' || e.id::text)) > (");
                    q.push_bind(created_at).push(", ").push_bind(id).push(")");
                }
                q.push(" ORDER BY e.created_at, e.id LIMIT ");
                q.push_bind(i64::try_from(limit + 1).unwrap_or(201));
                let mut items = q.build_query_as().fetch_all(tx.as_mut()).await?;
                let has_more = items.len() > limit;
                items.truncate(limit);
                Ok(RegisterReviewInboxPage {
                    items,
                    total,
                    has_more,
                })
            })
        })
        .await
    }
}
