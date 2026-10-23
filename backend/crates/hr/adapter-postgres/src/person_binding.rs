// SPDX-License-Identifier: LicenseRef-Proprietary
//! Durable system backfill evidence; the inbox adapter consumes this read side.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::{HrError, HrService};

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
        // Account evidence can span employments and branches of the tenant.
        crate::authz::authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let limit = query
            .limit
            .unwrap_or(crate::paging::DEFAULT_LIMIT)
            .clamp(1, crate::paging::MAX_LIMIT);
        let offset = query.offset.unwrap_or(0).max(0);
        let subject = query.subject_id;
        with_audits::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let total = sqlx::query_scalar("SELECT count(*) FROM person_binding_reviews WHERE ($1::uuid IS NULL OR subject_id=$1)")
                    .bind(subject).fetch_one(tx.as_mut()).await?;
                let items: Vec<PersonBindingReview> = sqlx::query_as("SELECT subject_kind,subject_id,reason,evidence,created_at FROM person_binding_reviews WHERE ($3::uuid IS NULL OR subject_id=$3) ORDER BY created_at,subject_kind,subject_id LIMIT $1 OFFSET $2")
                    .bind(limit).bind(offset).bind(subject).fetch_all(tx.as_mut()).await?;
                let subjects = items.iter().map(|item|item.subject_id).collect::<Vec<_>>();
                let me = actor_employee_id(tx,&principal).await?;
                let event = access_event(&principal,DirectoryAccess::PersonBindingReview,&subjects,me,serde_json::json!({"row_count":items.len()}))?;
                Ok((PersonBindingReviews { items, total, limit, offset },vec![event]))
            })
        }).await
    }
}
