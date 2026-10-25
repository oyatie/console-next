//! IMPORT-2: what an applied run records beyond MR-7's settle, from the plan
//! the operator saw (the stored dry run): a 휴직 the file recorded for a new
//! person, as an APPLIED LEAVE_OF_ABSENCE from its start date — a setup fact,
//! not a 발령 (decisions #26); the staged 주민등록번호 of every person the run
//! inserted or matched; and the value maps the run used (mapping memory).
//! Each write is skipped when already there, so a replayed settle completes.

use std::collections::BTreeMap;

use console_hr_domain::import::plan::Decisions;
use console_ontology_canonical_adapter_postgres::employment::{
    EmploymentChange, apply_employment_change,
};
use serde_json::Value;
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::import::{identities, memory};

const SETUP_LEAVE_COMMENT: &str = "Recorded by an import as a setup fact";

/// What this step wrote, for the settle's audit row.
#[derive(Debug, Default)]
pub struct SetupRecorded {
    pub leaves: usize,
    pub identities: usize,
}

async fn setup_leave(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    run: Uuid,
    employee: Uuid,
    leave: &Value,
) -> Result<bool, HrError> {
    let (Some(start), Some(kind)) = (leave["start_date"].as_str(), leave["leave_type"].as_str())
    else {
        return Ok(false);
    };
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM employee_lifecycle_events WHERE org_id = $1 \
           AND employee_id = $2 AND event_type = 'LEAVE_OF_ABSENCE')",
    )
    .bind(org)
    .bind(employee)
    .fetch_one(tx.as_mut())
    .await?;
    if exists {
        return Ok(false);
    }
    let event = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employee_lifecycle_events (id, org_id, employee_id, event_type, from_status, \
           to_status, effective_date, comment, signoffs, created_by, state, leave_type, \
           expected_return_date) \
         VALUES ($1, $2, $3, 'LEAVE_OF_ABSENCE', 'ACTIVE', 'ON_LEAVE', $4, $5, '{}'::jsonb, $6, \
           'APPLIED', $7, $8::DATE)",
    )
    .bind(event)
    .bind(org)
    .bind(employee)
    .bind(start)
    .bind(SETUP_LEAVE_COMMENT)
    .bind(actor)
    .bind(kind)
    .bind(leave["expected_return_date"].as_str())
    .execute(tx.as_mut())
    .await?;
    let head: (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT company, org_unit, position FROM employees WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(employee)
    .fetch_one(tx.as_mut())
    .await?;
    let change = EmploymentChange {
        company: &head.0,
        org_unit: head.1.as_deref(),
        position: head.2.as_deref(),
        employment_status: "ON_LEAVE",
        effective_date: start,
    };
    apply_employment_change(tx, org, employee, change).await?;
    crate::cases::open::event(tx, org, event).await?;
    crate::import::effects::record(tx, org, run, employee, "setup_leave", event).await?;
    Ok(true)
}

/// Records the 휴직, the sealed RRNs and the value memory of the rows `keys`
/// of an applied run (W11: one settle chunk); `last` drops what is left of
/// the run's staged identities.
pub async fn record_setup_facts(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    run: Uuid,
    (keys, last): (&[String], bool),
) -> Result<SetupRecorded, HrError> {
    let (plan, decisions): (Value, Value) = sqlx::query_as(
        "SELECT dry_run_summary->'rows', dry_run_decisions FROM data_import_runs \
          WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(run)
    .fetch_one(tx.as_mut())
    .await?;
    let inserted: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT source_key, employee_id FROM import_run_row_snapshots \
          WHERE org_id = $1 AND run_id = $2 AND outcome = 'INSERTED'",
    )
    .bind(org)
    .bind(run)
    .fetch_all(tx.as_mut())
    .await?;
    let mut people: BTreeMap<String, Uuid> = inserted
        .into_iter()
        .filter(|(key, _)| keys.contains(key))
        .collect();
    let mut recorded = SetupRecorded::default();
    for row in plan.as_array().into_iter().flatten() {
        let Some(key) = row["source_key"]
            .as_str()
            .filter(|key| keys.iter().any(|k| k == key))
        else {
            continue;
        };
        if let Some(id) = row["employee_id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
        {
            people.insert(key.to_owned(), id);
        }
        if let (Some(employee), leave) = (people.get(key), &row["new_person"]["leave"])
            && !leave.is_null()
            && setup_leave(tx, org, actor, run, *employee, leave).await?
        {
            recorded.leaves += 1;
        }
    }
    recorded.identities = identities::record(tx, org, actor, run, &people).await?;
    if last {
        identities::drop_staged(tx, org, run).await?;
        crate::import::phones::drop_staged(tx, org, Some(run), 0).await?;
    }
    let decisions: Decisions = serde_json::from_value(decisions)
        .map_err(|_| HrError::internal("stored import decisions are unreadable"))?;
    memory::remember_values(tx, org, actor, &decisions).await?;
    Ok(recorded)
}
