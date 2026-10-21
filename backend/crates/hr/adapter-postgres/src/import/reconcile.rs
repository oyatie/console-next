//! 이관 확인 (decisions #20, #25; spec E7-reconcile, E7-row, E7-signoff):
//! the server's account of an applied import — per-sheet funnels from the
//! run's own rows and plan, 배치 대조 per 사업장 against the live roster, one
//! verification state per run row, and the HR sign-off (`reconcile_write`).
//! Rows carry name, 사번 and unresolved company evidence; never the RRN.
//!
//! Every route needs `employee_directory_manage` org-wide, the import's gate.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::authorize_hr_org_wide;
use crate::import::apply::conflict;
use crate::{HrError, HrService, assignment_lateral};

/// The run's planned rows (every candidate row) with the employee each one
/// landed on: the plan's for an update, the apply snapshot's for an insert.
macro_rules! plan_cte {
    () => {
        "WITH plan AS (SELECT r->>'source_key' AS source_key, r->>'sheet' AS sheet, \
           (r->>'row')::INTEGER AS row_no, r->>'name' AS name, r->>'outcome' AS outcome, \
           COALESCE((r->>'employee_id')::UUID, s.employee_id) AS employee_id \
         FROM data_import_runs d CROSS JOIN LATERAL jsonb_array_elements(d.dry_run_summary->'rows') r \
         LEFT JOIN import_run_row_snapshots s \
           ON s.org_id = d.org_id AND s.run_id = d.id AND s.source_key = r->>'source_key' \
         WHERE d.org_id = $1 AND d.id = $2) "
    };
}
pub(super) use plan_cte;

#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
pub struct ReconcileCounts {
    pub rows: i64,
    pub confirmed: i64,
    pub needs_check: i64,
    pub unchecked: i64,
}

impl ReconcileCounts {
    /// What a sign-off attests over while still open (확인 필요 + 미확인).
    #[must_use]
    pub const fn open(&self) -> i64 {
        self.needs_check + self.unchecked
    }
}

#[derive(Debug, Serialize)]
pub struct SheetFunnel {
    pub sheet: String,
    pub read: i64,
    pub preserved: i64,
    pub errors: i64,
    pub candidates: i64,
    pub inserted: i64,
    pub updated: i64,
    pub unchanged: i64,
    pub excluded: i64,
}

/// 배치 대조, one 사업장 (null: 미배치): the run's people there now, the
/// people there the file did not name, and the total, current people only.
#[derive(Debug, Serialize)]
pub struct PlacementLine {
    pub workplace_id: Option<Uuid>,
    pub from_file: i64,
    pub outside_file: i64,
    pub now: i64,
}

#[derive(Debug, Serialize)]
pub struct ImportSignoff {
    pub signed_by: Uuid,
    pub signed_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub signed_at: OffsetDateTime,
    pub total_rows: i32,
    pub confirmed: i32,
    pub needs_check: i32,
    pub unchecked: i32,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportReconcile {
    pub run_id: Uuid,
    pub funnels: Vec<SheetFunnel>,
    pub placement: Vec<PlacementLine>,
    pub counts: ReconcileCounts,
    pub signoff: Option<ImportSignoff>,
}

/// 404 / 409 `import_not_applied`, or `apply_in_progress` until its job is done (W11).
pub(super) async fn applied_run(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    run_id: Uuid,
    lock: bool,
) -> Result<(), HrError> {
    let sql = if lock {
        "SELECT status, COALESCE(apply_job->>'state', 'done') FROM data_import_runs \
         WHERE org_id = $1 AND id = $2 AND entity_type = 'employee_hr' FOR UPDATE"
    } else {
        "SELECT status, COALESCE(apply_job->>'state', 'done') FROM data_import_runs \
         WHERE org_id = $1 AND id = $2 AND entity_type = 'employee_hr'"
    };
    let run: Option<(String, String)> = sqlx::query_as(sql)
        .bind(org)
        .bind(run_id)
        .fetch_optional(tx.as_mut())
        .await?;
    let refused = |code, message| Err(conflict(code, message, json!([])));
    match run.as_ref().map(|(s, j)| (s.as_str(), j.as_str())) {
        None => Err(console_kernel_core::KernelError::not_found("import run not found").into()),
        Some(("APPLIED", "done")) => Ok(()),
        Some(("APPLIED", _)) => refused("apply_in_progress", "the import is still being applied"),
        Some(_) => refused(
            "import_not_applied",
            "이관 확인 starts once the import is applied",
        ),
    }
}

pub(super) async fn counts(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    run_id: Uuid,
) -> Result<ReconcileCounts, HrError> {
    let (rows, confirmed, needs_check, unchecked): (i64, i64, i64, i64) = sqlx::query_as(concat!(
        plan_cte!(),
        "SELECT count(*), count(*) FILTER (WHERE c.state = 'CONFIRMED'), \
           count(*) FILTER (WHERE c.state = 'NEEDS_CHECK'), count(*) FILTER (WHERE c.state IS NULL) \
         FROM plan p LEFT JOIN import_reconcile_checks c \
           ON c.org_id = $1 AND c.run_id = $2 AND c.source_key = p.source_key"
    ))
    .bind(org)
    .bind(run_id)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(ReconcileCounts {
        rows,
        confirmed,
        needs_check,
        unchecked,
    })
}

pub(super) async fn signoff(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    run_id: Uuid,
) -> Result<Option<ImportSignoff>, HrError> {
    let row = sqlx::query(
        "SELECT s.signed_by, u.display_name, s.signed_at, s.total_rows, s.confirmed, \
         s.needs_check, s.unchecked, s.note FROM import_signoffs s \
         LEFT JOIN users u ON u.id = s.signed_by WHERE s.org_id = $1 AND s.run_id = $2",
    )
    .bind(org)
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?;
    row.map(|row| {
        Ok(ImportSignoff {
            signed_by: row.try_get(0)?,
            signed_by_name: row.try_get(1)?,
            signed_at: row.try_get(2)?,
            total_rows: row.try_get(3)?,
            confirmed: row.try_get(4)?,
            needs_check: row.try_get(5)?,
            unchecked: row.try_get(6)?,
            note: row.try_get(7)?,
        })
    })
    .transpose()
}

async fn funnels(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    run_id: Uuid,
) -> Result<Vec<SheetFunnel>, HrError> {
    let rows = sqlx::query(concat!(
        plan_cte!(),
        ", outcomes AS (SELECT sheet, count(*) FILTER (WHERE outcome = 'insert') AS inserted, \
           count(*) FILTER (WHERE outcome = 'update') AS updated, \
           count(*) FILTER (WHERE outcome = 'unchanged') AS unchanged, \
           count(*) FILTER (WHERE outcome = 'excluded') AS excluded FROM plan GROUP BY sheet), \
         read AS (SELECT source_sheet AS sheet, count(*) AS read, \
           count(*) FILTER (WHERE row_status = 'PRESERVED') AS preserved, \
           count(*) FILTER (WHERE row_status = 'ERROR') AS errors, \
           count(*) FILTER (WHERE row_status = 'CANDIDATE') AS candidates \
         FROM data_import_rows WHERE org_id = $1 AND run_id = $2 GROUP BY source_sheet) \
         SELECT COALESCE(r.sheet, o.sheet) AS sheet, COALESCE(r.read, 0) AS read, \
           COALESCE(r.preserved, 0) AS preserved, COALESCE(r.errors, 0) AS errors, \
           COALESCE(r.candidates, 0) AS candidates, COALESCE(o.inserted, 0) AS inserted, \
           COALESCE(o.updated, 0) AS updated, COALESCE(o.unchanged, 0) AS unchanged, \
           COALESCE(o.excluded, 0) AS excluded \
         FROM read r FULL JOIN outcomes o ON o.sheet = r.sheet ORDER BY 1"
    ))
    .bind(org)
    .bind(run_id)
    .fetch_all(tx.as_mut())
    .await?;
    rows.iter()
        .map(|row| {
            Ok(SheetFunnel {
                sheet: row.try_get("sheet")?,
                read: row.try_get("read")?,
                preserved: row.try_get("preserved")?,
                errors: row.try_get("errors")?,
                candidates: row.try_get("candidates")?,
                inserted: row.try_get("inserted")?,
                updated: row.try_get("updated")?,
                unchanged: row.try_get("unchanged")?,
                excluded: row.try_get("excluded")?,
            })
        })
        .collect()
}

// one GROUP BY over the tenant's current people per read (bounded by
// headcount, ~2k-30k rows); cache by run when a 30k tenant's p95 needs it.
async fn placement(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    run_id: Uuid,
) -> Result<Vec<PlacementLine>, HrError> {
    let rows: Vec<(Option<Uuid>, i64, i64, i64)> = sqlx::query_as(concat!(
        plan_cte!(),
        ", people AS (SELECT DISTINCT employee_id FROM plan \
           WHERE employee_id IS NOT NULL AND outcome IN ('insert', 'update', 'unchanged')) \
         SELECT ea.workplace_id, count(*) FILTER (WHERE pp.employee_id IS NOT NULL), \
           count(*) FILTER (WHERE pp.employee_id IS NULL), count(*) \
         FROM employees e",
        assignment_lateral!(),
        " LEFT JOIN people pp ON pp.employee_id = e.id \
         WHERE e.org_id = $1 AND e.employment_status <> 'EXITED' \
         GROUP BY ea.workplace_id ORDER BY ea.workplace_id NULLS LAST"
    ))
    .bind(org)
    .bind(run_id)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(workplace_id, from_file, outside_file, now)| PlacementLine {
                workplace_id,
                from_file,
                outside_file,
                now,
            },
        )
        .collect())
}

/// `?state=UNCHECKED|CONFIRMED|NEEDS_CHECK&after=&limit=` of the rows page.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReconcileRowsQuery {
    #[serde(default)]
    pub state: Option<String>,
    /// The previous page's `next_cursor`.
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

impl HrService {
    /// `GET /api/v1/employees/import/{run_id}/reconcile`.
    pub async fn import_reconcile(
        &self,
        principal: Principal,
        run_id: Uuid,
    ) -> Result<ImportReconcile, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let org = *principal.org_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                applied_run(tx, org, run_id, false).await?;
                Ok(ImportReconcile {
                    run_id,
                    funnels: funnels(tx, org, run_id).await?,
                    placement: placement(tx, org, run_id).await?,
                    counts: counts(tx, org, run_id).await?,
                    signoff: signoff(tx, org, run_id).await?,
                })
            })
        })
        .await
    }
}
