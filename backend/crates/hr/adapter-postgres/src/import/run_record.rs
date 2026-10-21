// SPDX-License-Identifier: LicenseRef-Proprietary
//! Import history reads the stored apply result, never today's roster.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, postgres::PgRow};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::authz::authorize_hr_org_wide;
use crate::{HrError, HrService};

const DEFAULT_PAGE: i64 = 20;
const MAX_PAGE: i64 = 100;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunListQuery {
    pub limit: Option<i64>,
    pub after: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RunActor {
    pub id: Uuid,
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EmployeeImportRun {
    pub id: Uuid,
    pub source_filename: String,
    pub status: String,
    pub apply_job_state: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub applied_at: Option<OffsetDateTime>,
    pub applied_by: Option<RunActor>,
    pub apply_summary: Option<Value>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub rolled_back_at: Option<OffsetDateTime>,
    pub rolled_back_by: Option<RunActor>,
    pub rollback_reason_code: Option<String>,
    pub rollback_note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EmployeeImportRunPage {
    pub items: Vec<EmployeeImportRun>,
    pub next_cursor: Option<String>,
}

macro_rules! record_select {
    () => {
        "SELECT r.id, r.source_filename, r.status, r.apply_job->>'state' AS apply_job_state, r.created_at, r.applied_at, \
         r.applied_by, a.display_name AS applied_by_name, \
         CASE WHEN r.status IN ('APPLIED', 'ROLLED_BACK') THEN r.apply_summary END AS apply_summary, r.rolled_back_at, \
         r.rolled_back_by, b.display_name AS rolled_back_by_name, \
         r.rollback_reason_code, r.rollback_note \
         FROM data_import_runs r \
         LEFT JOIN users a ON a.org_id = r.org_id AND a.id = r.applied_by \
         LEFT JOIN users b ON b.org_id = r.org_id AND b.id = r.rolled_back_by \
         WHERE r.org_id = $1 AND r.entity_type = 'employee_hr' "
    };
}

fn record(row: PgRow) -> Result<EmployeeImportRun, HrError> {
    let actor = |id: &str, name: &str| -> Result<Option<RunActor>, HrError> {
        let id: Option<Uuid> = row.try_get(id)?;
        id.map(|id| {
            Ok(RunActor {
                id,
                name: row.try_get(name)?,
            })
        })
        .transpose()
    };
    Ok(EmployeeImportRun {
        id: row.try_get("id")?,
        source_filename: row.try_get("source_filename")?,
        status: row.try_get("status")?,
        apply_job_state: row.try_get("apply_job_state")?,
        created_at: row.try_get("created_at")?,
        applied_at: row.try_get("applied_at")?,
        applied_by: actor("applied_by", "applied_by_name")?,
        apply_summary: row.try_get("apply_summary")?,
        rolled_back_at: row.try_get("rolled_back_at")?,
        rolled_back_by: actor("rolled_back_by", "rolled_back_by_name")?,
        rollback_reason_code: row.try_get("rollback_reason_code")?,
        rollback_note: row.try_get("rollback_note")?,
    })
}

fn cursor(value: &str) -> Result<(OffsetDateTime, Uuid), HrError> {
    let bad = || HrError::validation("after is not an employee import run cursor");
    let (at, id) = value.split_once('_').ok_or_else(bad)?;
    Ok((
        OffsetDateTime::parse(at, &Rfc3339).map_err(|_| bad())?,
        Uuid::parse_str(id).map_err(|_| bad())?,
    ))
}

impl HrService {
    pub async fn import_run(
        &self,
        principal: Principal,
        run: Uuid,
    ) -> Result<EmployeeImportRun, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(concat!(record_select!(), "AND r.id = $2"))
                    .bind(*principal.org_id.as_uuid())
                    .bind(run)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| HrError {
                        status: http::StatusCode::NOT_FOUND,
                        code: "import_run_not_found",
                        message: "employee import run not found".into(),
                        refusals: None,
                    })?;
                record(row)
            })
        })
        .await
    }

    pub async fn import_runs(
        &self,
        principal: Principal,
        query: RunListQuery,
    ) -> Result<EmployeeImportRunPage, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let limit = query.limit.unwrap_or(DEFAULT_PAGE);
        if !(1..=MAX_PAGE).contains(&limit) {
            return Err(HrError::validation(format!(
                "limit must be between 1 and {MAX_PAGE}"
            )));
        }
        let after = query.after.as_deref().map(cursor).transpose()?;
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(concat!(
                    record_select!(),
                    "AND r.status IN ('APPLIED', 'ROLLED_BACK') \
                     AND COALESCE(r.apply_job->>'state', 'done') = 'done' \
                     AND ($2::TIMESTAMPTZ IS NULL OR (r.applied_at, r.id) < ($2, $3)) \
                     ORDER BY r.applied_at DESC, r.id DESC LIMIT $4"
                ))
                .bind(*principal.org_id.as_uuid())
                .bind(after.map(|p| p.0))
                .bind(after.map(|p| p.1))
                .bind(limit + 1)
                .fetch_all(tx.as_mut())
                .await?;
                let mut items: Vec<_> = rows.into_iter().map(record).collect::<Result<_, _>>()?;
                let more = i64::try_from(items.len()).unwrap_or(i64::MAX) > limit;
                if more {
                    items.pop();
                }
                let next_cursor = items
                    .last()
                    .filter(|_| more)
                    .map(|last| {
                        let at = last
                            .applied_at
                            .ok_or_else(|| HrError::internal("applied run has no applied_at"))?;
                        let at = at
                            .format(&Rfc3339)
                            .map_err(|_| HrError::internal("import cursor date"))?;
                        Ok::<_, HrError>(format!("{at}_{}", last.id))
                    })
                    .transpose()?;
                Ok(EmployeeImportRunPage { items, next_cursor })
            })
        })
        .await
    }
}
