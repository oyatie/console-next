//! The 이관 확인 rows: one per planned row of an applied run, keyset by
//! (sheet, row), filtered by state. Unresolved company cells retain their source; no RRN.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

use super::reconcile::{ReconcileRowsQuery, applied_run, plan_cte};
use crate::authz::authorize_hr_org_wide;
use crate::{HrError, HrService};

pub const DEFAULT_RECONCILE_PAGE: i64 = 100;
pub const MAX_RECONCILE_PAGE: i64 = 500;

#[derive(Debug, Serialize)]
pub struct ReconcileRow {
    pub source_key: String,
    pub sheet: String,
    pub row: i32,
    pub name: Option<String>,
    pub employee_id: Option<Uuid>,
    pub employee_number: Option<String>,
    /// The plan's outcome: insert, update, unchanged or excluded.
    pub outcome: String,
    /// UNCHECKED (never set), CONFIRMED or NEEDS_CHECK.
    pub state: String,
    pub note: Option<String>,
    pub checked_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub checked_at: Option<OffsetDateTime>,
    /// 0 while UNCHECKED; send it back as `expected_version`.
    pub version: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_confirmation:
        Option<console_hr_domain::import::company_review::CompanyConfirmation>,
}

#[derive(Debug, Serialize)]
pub struct ReconcileRowPage {
    pub items: Vec<ReconcileRow>,
    pub next_cursor: Option<String>,
}

fn bad(message: &str) -> HrError {
    HrError::validation(message.to_owned())
}

/// `<row>:<sheet>` (the row first: a sheet name may hold any character).
fn decode(cursor: &str) -> Result<(String, i32), HrError> {
    let (row, sheet) = cursor
        .split_once(':')
        .ok_or_else(|| bad("after is not a cursor this list returned"))?;
    let row = row
        .parse()
        .map_err(|_| bad("after is not a cursor this list returned"))?;
    Ok((sheet.to_owned(), row))
}

fn state_filter(raw: Option<&str>) -> Result<Option<&'static str>, HrError> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => ["UNCHECKED", "CONFIRMED", "NEEDS_CHECK"]
            .into_iter()
            .find(|known| known.eq_ignore_ascii_case(s))
            .map(Some)
            .ok_or_else(|| bad("state must be UNCHECKED, CONFIRMED or NEEDS_CHECK")),
    }
}

/// The rows of an applied run: by state and keyset, or the one `key`.
pub(super) struct RowFilter<'a> {
    pub state: Option<&'static str>,
    pub after: Option<(String, i32)>,
    pub limit: i64,
    pub key: Option<&'a str>,
}

pub(super) async fn load_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    run_id: Uuid,
    filter: RowFilter<'_>,
) -> Result<Vec<ReconcileRow>, HrError> {
    let rows = sqlx::query(concat!(
        plan_cte!(),
        "SELECT p.source_key, p.sheet, p.row_no, p.name, p.employee_id, p.outcome, \
           e.employee_number, COALESCE(c.state, 'UNCHECKED') AS state, c.note, \
           c.checked_by, c.checked_at, COALESCE(c.version, 0) AS version \
         FROM plan p \
         LEFT JOIN employees e ON e.org_id = $1 AND e.id = p.employee_id \
         LEFT JOIN import_reconcile_checks c \
           ON c.org_id = $1 AND c.run_id = $2 AND c.source_key = p.source_key \
         WHERE ($3::TEXT IS NULL OR COALESCE(c.state, 'UNCHECKED') = $3) \
           AND ($4::TEXT IS NULL OR (p.sheet, p.row_no) > ($4, $5)) \
           AND ($7::TEXT IS NULL OR p.source_key = $7) \
         ORDER BY p.sheet, p.row_no LIMIT $6"
    ))
    .bind(org)
    .bind(run_id)
    .bind(filter.state)
    .bind(filter.after.as_ref().map(|a| a.0.clone()))
    .bind(filter.after.as_ref().map(|a| a.1))
    .bind(filter.limit)
    .bind(filter.key)
    .fetch_all(tx.as_mut())
    .await?;
    let mut rows = rows
        .iter()
        .map(|row| {
            Ok(ReconcileRow {
                source_key: row.try_get("source_key")?,
                sheet: row.try_get("sheet")?,
                row: row.try_get("row_no")?,
                name: row.try_get("name")?,
                employee_id: row.try_get("employee_id")?,
                employee_number: row.try_get("employee_number")?,
                outcome: row.try_get("outcome")?,
                state: row.try_get("state")?,
                note: row.try_get("note")?,
                checked_by: row.try_get("checked_by")?,
                checked_at: row.try_get("checked_at")?,
                version: row.try_get("version")?,
                company_confirmation: None,
            })
        })
        .collect::<Result<Vec<_>, HrError>>()?;
    super::reconcile_company::fill(tx, org, run_id, &mut rows).await?;
    Ok(rows)
}

impl HrService {
    /// `GET /api/v1/employees/import/{run_id}/reconcile/rows`.
    pub async fn import_reconcile_rows(
        &self,
        principal: Principal,
        run_id: Uuid,
        query: ReconcileRowsQuery,
    ) -> Result<ReconcileRowPage, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let state = state_filter(query.state.as_deref())?;
        let after = query.after.as_deref().map(decode).transpose()?;
        let limit = query
            .limit
            .unwrap_or(DEFAULT_RECONCILE_PAGE)
            .clamp(1, MAX_RECONCILE_PAGE);
        let org = *principal.org_id.as_uuid();
        let mut items = with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                applied_run(tx, org, run_id, false).await?;
                let filter = RowFilter {
                    state,
                    after,
                    limit: limit + 1,
                    key: None,
                };
                load_rows(tx, org, run_id, filter).await
            })
        })
        .await?;
        let size = usize::try_from(limit).unwrap_or(1);
        let next_cursor = if items.len() > size {
            items.truncate(size);
            items
                .last()
                .map(|last| format!("{}:{}", last.row, last.sheet))
        } else {
            None
        };
        Ok(ReconcileRowPage { items, next_cursor })
    }
}
