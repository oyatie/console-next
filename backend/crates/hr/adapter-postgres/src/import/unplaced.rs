//! W03 / E8: the 미배치 queue — current people an import (or anything else)
//! left without a 사업장, or without the 부서 their file named, with the
//! file's own 부서 text and why. Counted for the roster chip, keyset-paged by
//! (`created_at`, id).

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::authz::authorize_hr_org_wide;
use crate::{HrError, HrService, assignment_lateral};

const DEFAULT_PAGE: i64 = 100;
const MAX_PAGE: i64 = 500;

/// `?run_id=&after=&limit=`: only the people `run_id` inserted, after a
/// previous page's `next_cursor`.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnplacedQuery {
    #[serde(default)]
    pub run_id: Option<Uuid>,
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct UnplacedPerson {
    pub employee_id: Uuid,
    pub name: String,
    pub employee_number: Option<String>,
    pub company: String,
    pub legal_entity_id: Option<Uuid>,
    pub workplace_id: Option<Uuid>,
    pub org_unit_id: Option<Uuid>,
    /// The 부서 text the file named that bound nothing (원본 부서).
    pub source_org_unit: Option<String>,
    /// `no_place`, `workplace_unknown`, `unit_unknown`.
    pub reason: &'static str,
    /// r3:hire-21: the facts the queue decides placement with, read with the
    /// person (never a roster page that stops at 1,000).
    pub position: Option<String>,
    pub employment_type: Option<String>,
    pub hire_date: Option<String>,
    pub worksite_name: Option<String>,
    pub org_unit: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UnplacedPage {
    pub count: i64,
    pub items: Vec<UnplacedPerson>,
    pub next_cursor: Option<String>,
}

/// Current people with no 사업장, or without the 부서 their file named.
macro_rules! unplaced {
    () => {
        concat!(
            " FROM employees e",
            assignment_lateral!(),
            " LEFT JOIN employee_employment_profiles p \
               ON p.org_id = e.org_id AND p.employee_id = e.id",
            " WHERE e.org_id = $1 AND e.employment_status <> 'EXITED' \
               AND e.merged_into_employee_id IS NULL \
               AND (ea.workplace_id IS NULL \
                    OR (e.org_unit_id IS NULL AND e.source_metadata ? 'unresolved_org_unit')) \
               AND ($2::UUID IS NULL OR EXISTS (SELECT 1 FROM import_run_row_snapshots s \
                    WHERE s.org_id = e.org_id AND s.run_id = $2 AND s.employee_id = e.id \
                      AND s.outcome = 'INSERTED'))"
        )
    };
}

fn reason(workplace: Option<Uuid>, unit: Option<Uuid>) -> &'static str {
    match (workplace, unit) {
        (None, None) => "no_place",
        (None, Some(_)) => "workplace_unknown",
        (Some(_), _) => "unit_unknown",
    }
}

fn decode(cursor: &str) -> Result<(OffsetDateTime, Uuid), HrError> {
    let bad = || HrError::validation("after is not a cursor of this list");
    let (at, id) = cursor.split_once('_').ok_or_else(bad)?;
    let at = OffsetDateTime::parse(at, &Rfc3339).map_err(|_| bad())?;
    Ok((at, Uuid::parse_str(id).map_err(|_| bad())?))
}

impl HrService {
    /// `GET /api/v1/employees/import/unplaced`.
    ///
    /// # Errors
    /// 403 without org-wide `employee_directory_manage`; 422 for a cursor
    /// this list did not issue.
    pub async fn import_unplaced(
        &self,
        principal: Principal,
        query: UnplacedQuery,
    ) -> Result<UnplacedPage, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let after = query.after.as_deref().map(decode).transpose()?;
        let limit = query.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);
        let org = *principal.org_id.as_uuid();
        let (count, rows) =
            with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
                Box::pin(async move {
                    let count: i64 = sqlx::query_scalar(concat!("SELECT count(*)", unplaced!()))
                        .bind(org)
                        .bind(query.run_id)
                        .fetch_one(tx.as_mut())
                        .await?;
                    let rows = sqlx::query(concat!(
                        "SELECT e.id, e.name, e.employee_number, e.company, ea.legal_entity_id, \
                       ea.workplace_id, e.org_unit_id, \
                       e.source_metadata->>'unresolved_org_unit' AS source_org_unit, e.created_at, \
                       e.position, p.employment_type, e.hire_date::TEXT AS hire_date, \
                       e.worksite_name, e.org_unit",
                        unplaced!(),
                        " AND ($3::TIMESTAMPTZ IS NULL OR (e.created_at, e.id) > ($3, $4)) \
                     ORDER BY e.created_at, e.id LIMIT $5"
                    ))
                    .bind(org)
                    .bind(query.run_id)
                    .bind(after.map(|a| a.0))
                    .bind(after.map(|a| a.1))
                    .bind(limit + 1)
                    .fetch_all(tx.as_mut())
                    .await?;
                    Ok((count, rows))
                })
            })
            .await?;
        let size = usize::try_from(limit).unwrap_or(1);
        let mut next_cursor = None;
        let mut items = Vec::with_capacity(rows.len().min(size));
        for (i, row) in rows.iter().enumerate() {
            let at: OffsetDateTime = row.try_get("created_at")?;
            let id: Uuid = row.try_get("id")?;
            if i == size {
                break;
            }
            if i + 1 == size && rows.len() > size {
                let at = at
                    .format(&Rfc3339)
                    .map_err(|_| HrError::internal("created_at is not formattable"))?;
                next_cursor = Some(format!("{at}_{id}"));
            }
            let (workplace_id, org_unit_id) =
                (row.try_get("workplace_id")?, row.try_get("org_unit_id")?);
            items.push(UnplacedPerson {
                employee_id: id,
                name: row.try_get("name")?,
                employee_number: row.try_get("employee_number")?,
                company: row.try_get("company")?,
                legal_entity_id: row.try_get("legal_entity_id")?,
                workplace_id,
                org_unit_id,
                source_org_unit: row.try_get("source_org_unit")?,
                reason: reason(workplace_id, org_unit_id),
                position: row.try_get("position")?,
                employment_type: row.try_get("employment_type")?,
                hire_date: row.try_get("hire_date")?,
                worksite_name: row.try_get("worksite_name")?,
                org_unit: row.try_get("org_unit")?,
            });
        }
        Ok(UnplacedPage {
            count,
            items,
            next_cursor,
        })
    }
}
