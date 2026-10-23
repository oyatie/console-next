// SPDX-License-Identifier: LicenseRef-Proprietary
//! Durable system backfill evidence; the inbox adapter consumes this read side.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, QueryBuilder};

use crate::authz::{HrReach, Tier, hr_reach_in, push_reach};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::{HrError, HrService};

/// Alias `e`: the legacy marker and durable evidence require the same decision.
#[macro_export]
macro_rules! identity_review_sql {
    () => {
        "(e.identity_review_required OR EXISTS(SELECT 1 FROM person_binding_reviews_open r \
         WHERE r.org_id=e.org_id AND r.subject_kind='EMPLOYEE' AND r.subject_id=e.id))"
    };
}

#[derive(Debug, Deserialize, Default)]
pub struct ReviewQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub subject_id: Option<Uuid>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PersonBindingReview {
    pub subject_kind: String,
    pub subject_id: Uuid,
    pub reason: String,
    pub evidence: serde_json::Value,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
pub struct PersonBindingReviews {
    pub items: Vec<PersonBindingReview>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

impl HrService {
    pub async fn person_binding_reviews(
        &self,
        principal: Principal,
        query: ReviewQuery,
    ) -> Result<PersonBindingReviews, HrError> {
        let reach = hr_reach_in(&principal, Feature::EmployeeDirectoryManage, Tier::Branch)?;
        let limit = query
            .limit
            .unwrap_or(crate::paging::DEFAULT_LIMIT)
            .clamp(1, crate::paging::MAX_LIMIT);
        let offset = query.offset.unwrap_or(0).max(0);
        let subject = query.subject_id;
        with_audits::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let mut count = visible_reviews(&reach, subject);
                count.push(" SELECT count(*) FROM reviews");
                let total = count.build_query_scalar().fetch_one(tx.as_mut()).await?;
                let mut rows = visible_reviews(&reach, subject);
                rows.push(" SELECT subject_kind,subject_id,reason,evidence || jsonb_build_object('candidates', \
                    coalesce((SELECT jsonb_agg(c.value || jsonb_build_object('name',e.name,'employee_number',e.employee_number) ORDER BY e.id) \
                    FROM jsonb_array_elements(reviews.evidence->'candidates') c \
                    JOIN visible_employees e ON e.id=(c.value->>'employee_id')::uuid),'[]'::jsonb)) AS evidence,created_at \
                    FROM reviews ORDER BY created_at,subject_kind,subject_id LIMIT ");
                rows.push_bind(limit).push(" OFFSET ").push_bind(offset);
                let items: Vec<PersonBindingReview> = rows.build_query_as().fetch_all(tx.as_mut()).await?;
                let subjects = items.iter().map(|item|item.subject_id).collect::<Vec<_>>();
                let me = actor_employee_id(tx,&principal).await?;
                let event = access_event(&principal,DirectoryAccess::PersonBindingReview,&subjects,me,serde_json::json!({"row_count":items.len()}))?;
                Ok((PersonBindingReviews { items, total, limit, offset },vec![event]))
            })
        }).await
    }
}

fn visible_reviews(reach: &HrReach, subject: Option<Uuid>) -> QueryBuilder<Postgres> {
    let mut q = QueryBuilder::new(
        "WITH visible_employees AS (SELECT e.id,e.name,e.employee_number FROM person_employees_current e",
    );
    q.push(crate::assignment_lateral!()).push(" WHERE ");
    push_reach(&mut q, reach);
    q.push("), reviews AS (SELECT r.* FROM person_binding_reviews_open r WHERE (");
    q.push_bind(subject)
        .push("::uuid IS NULL OR r.subject_id=")
        .push_bind(subject)
        .push(") ");
    if *reach != HrReach::All {
        q.push("AND ((r.subject_kind='EMPLOYEE' AND r.subject_id IN (SELECT id FROM visible_employees)) \
            OR (r.subject_kind='ACCOUNT' AND EXISTS(SELECT 1 FROM users u WHERE u.org_id=r.org_id \
            AND u.id=r.subject_id AND u.employee_id IN (SELECT id FROM visible_employees))) \
            OR (r.subject_kind='ACCOUNT' AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.evidence->'candidates') c \
            JOIN visible_employees e ON e.id=(c->>'employee_id')::uuid))) ");
    }
    q.push(")");
    q
}
