//! BW-10 7: apply is bound to the dry run the operator saw. It re-plans the
//! run with the stored decisions against the live roster; any difference is
//! 409 `rows_changed_since_preview` naming the rows. The leave command then
//! writes the plan (one statement, all or nothing), and the settle opens what
//! the new people need: the canonical employment of a current employee, the
//! SCHEDULED ONBOARD of an 입사 예정 one. W11: both run as a job
//! (`apply_drive`).

use console_hr_domain::import::plan::{Decisions, PlannedRow};
use console_kernel_core::KernelError;
use console_leave_adapter_postgres::PgLeaveError;
use console_platform_db::DbError;
use serde_json::{Value, json};
use sqlx::Postgres;
use std::collections::BTreeMap;
use uuid::Uuid;

use crate::import::apply_job::require_row_limit;
use crate::import::apply_rows::batch_rows;
use crate::import::company::entity_names;
use crate::import::dry_run::{plan_digest, plan_run};
use crate::import::store::import_run_for_update;
use crate::import::types::EmployeeImportReport;
use crate::{HrError, HrService};

/// Name → ids of every ACTIVE Site/Department/Team in the armed tenant.
pub async fn active_org_units_by_name(
    tx: &mut sqlx::Transaction<'_, Postgres>,
) -> Result<BTreeMap<String, Vec<Uuid>>, HrError> {
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT u.id, latest.attributes->>'name' FROM org_units u \
         JOIN LATERAL ( \
             SELECT attributes FROM org_unit_revisions r \
             WHERE r.org_id = u.org_id AND r.org_unit_id = u.id \
             ORDER BY r.version DESC LIMIT 1 \
         ) latest ON true \
         WHERE latest.attributes->>'kind' IN ('site', 'department', 'team') \
           AND COALESCE(latest.attributes->>'status', 'active') <> 'dissolved' \
           AND latest.attributes->>'name' IS NOT NULL",
    )
    .fetch_all(tx.as_mut())
    .await?;
    let mut by_name = BTreeMap::<String, Vec<Uuid>>::new();
    for (id, name) in rows {
        by_name.entry(name).or_default().push(id);
    }
    Ok(by_name)
}

pub(crate) fn conflict(code: &'static str, message: &str, refusals: Value) -> HrError {
    HrError {
        errors: None,
        status: http::StatusCode::CONFLICT,
        code,
        message: message.to_owned(),
        refusals: Some(Box::new(refusals)),
    }
}

/// The rows whose plan differs from the one the dry run stored.
fn changed_rows(stored: &Value, now: &[PlannedRow]) -> Value {
    let before: BTreeMap<&str, &Value> = stored["rows"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| Some((row["source_key"].as_str()?, row)))
                .collect()
        })
        .unwrap_or_default();
    let changed: Vec<Value> = now
        .iter()
        .filter(|row| before.get(row.source_key.as_str()) != Some(&&json!(row)))
        .map(|row| {
            json!({
                "source_key": row.source_key,
                "sheet": row.sheet,
                "row": row.row,
                "outcome_before": before.get(row.source_key.as_str()).map(|b| b["outcome"].clone()),
                "outcome_now": row.outcome,
            })
        })
        .collect();
    json!(changed)
}

/// The leave command's refusal of a row that moved after the re-plan.
pub(crate) fn apply_failure(error: PgLeaveError) -> HrError {
    if let PgLeaveError::Db(DbError::Sqlx(sqlx)) = &error
        && let Some(db) = sqlx.as_database_error()
        && db.message() == "employee_import_batch.rows_changed"
    {
        let source_key = db
            .try_downcast_ref::<sqlx::postgres::PgDatabaseError>()
            .and_then(|pg| pg.detail().map(str::to_owned));
        return conflict(
            "rows_changed_since_preview",
            "the roster changed after the dry run; run it again",
            json!([{ "source_key": source_key }]),
        );
    }
    HrError::from_leave_store(error)
}

/// What the checked re-plan hands to the leave command.
pub(crate) enum Checked {
    Replay(EmployeeImportReport),
    Apply(Value),
}

pub(crate) async fn check_and_build(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
    digest: &str,
) -> Result<Checked, HrError> {
    let run = import_run_for_update(tx, org_uuid, run_id).await?;
    if run.entity_type != "employee_hr" {
        return Err(HrError::validation(
            "import run entity_type is not employee_hr",
        ));
    }
    let (status, summary, stored_digest, decisions): (String, Value, Option<String>, Value) =
        sqlx::query_as(
            "SELECT status, CASE WHEN status = 'APPLIED' THEN apply_summary ELSE dry_run_summary END, \
                    dry_run_digest, dry_run_decisions \
             FROM data_import_runs WHERE org_id = $1 AND id = $2",
        )
        .bind(org_uuid)
        .bind(run_id)
        .fetch_one(tx.as_mut())
        .await?;
    if status == "APPLIED" && stored_digest.as_deref() == Some(digest) {
        let report = serde_json::from_value(summary)
            .map_err(|_| HrError::internal("stored import report is unreadable"))?;
        return Ok(Checked::Replay(report));
    }
    if status != "DRY_RUN" {
        return Err(HrError::from_kernel(KernelError::invalid_transition(
            format!("apply requires DRY_RUN status, got {status}"),
        )));
    }
    crate::import::identities::require_fresh_run(tx, org_uuid, run_id).await?;
    require_row_limit(tx, org_uuid, run_id).await?;
    if stored_digest.as_deref() != Some(digest) {
        return Err(conflict(
            "dry_run_digest_mismatch",
            "this is not the latest dry run of the run; reload it",
            json!([]),
        ));
    }
    let unsettled: Vec<Value> = summary["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| {
            !matches!(
                row["outcome"].as_str(),
                Some("insert" | "update" | "unchanged" | "excluded")
            )
        })
        .map(|row| json!({ "source_key": row["source_key"], "outcome": row["outcome"] }))
        .collect();
    // IMPORT-2: a sheet still waiting for its mapping keeps apply closed too,
    // and (W02) a blocking value nobody mapped on rows the plan would insert.
    let unsettled: Vec<Value> = unsettled
        .into_iter()
        .chain(
            summary["review"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| {
                    item["blocking"] == true
                        && (item["row"].is_null() || item["reason"] == "employment_type_unmapped")
                })
                .map(|item| {
                    json!({ "sheet": item["sheet"], "outcome": item["reason"], "value": item["value"] })
                }),
        )
        .collect();
    if !unsettled.is_empty() {
        return Err(HrError {
            errors: None,
            status: http::StatusCode::UNPROCESSABLE_ENTITY,
            code: "import_unresolved",
            message: "every row must be resolved or excluded before apply".to_owned(),
            refusals: Some(Box::new(json!(unsettled))),
        });
    }
    let decisions: Decisions = serde_json::from_value(decisions)
        .map_err(|_| HrError::internal("stored import decisions are unreadable"))?;
    let (stored, _, plan) = plan_run(tx, org_uuid, run_id, &decisions).await?;
    if plan_digest(&plan)? != digest {
        return Err(conflict(
            "rows_changed_since_preview",
            "the roster changed after the dry run; run it again",
            changed_rows(&summary, &plan),
        ));
    }
    let entities = entity_names(tx, org_uuid, &plan).await?;
    Ok(Checked::Apply(batch_rows(&stored, &plan, &entities)))
}

impl HrService {
    /// The legacy one-shot workbook import (`POST /employees/import`) is gone
    /// (BW-10 8): it matched people by file position. 410 names the staged
    /// flow instead.
    pub fn import_workbook_gone(&self) -> HrError {
        HrError {
            errors: None,
            status: http::StatusCode::GONE,
            code: "legacy_import_removed",
            message: "use POST /api/v1/employees/import/preview, then dry-run and apply".to_owned(),
            refusals: None,
        }
    }
}
