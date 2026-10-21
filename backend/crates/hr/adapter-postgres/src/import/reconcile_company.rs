//! Applied company aliases keep their source evidence until a person confirms the employer.
use std::collections::BTreeMap;

use console_hr_domain::import::company_review::{CompanyConfirmation, needs_confirmation};
use console_hr_domain::import::plan::{Decisions, ImportRow};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::reconcile_rows::ReconcileRow;
use crate::{HrError, clock::today_kst};

pub(super) async fn fill(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    run: Uuid,
    rows: &mut [ReconcileRow],
) -> Result<(), HrError> {
    if rows.is_empty() {
        return Ok(());
    }
    let keys: Vec<_> = rows.iter().map(|r| r.source_key.clone()).collect();
    let sources = sqlx::query("SELECT canonical_row FROM data_import_rows WHERE org_id = $1 AND run_id = $2 AND canonical_row->>'source_key' = ANY($3)")
        .bind(org).bind(run).bind(&keys).fetch_all(tx.as_mut()).await?;
    let sources: BTreeMap<String, Value> = sources
        .into_iter()
        .map(|r| {
            let data: Value = r.try_get("canonical_row")?;
            let key = data["source_key"]
                .as_str()
                .ok_or_else(|| HrError::internal("import source key missing"))?
                .to_owned();
            Ok((key, data))
        })
        .collect::<Result<_, HrError>>()?;
    let decisions: Value = sqlx::query_scalar(
        "SELECT COALESCE(dry_run_summary->'decisions', '{}'::jsonb) FROM data_import_runs WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(run)
    .fetch_one(tx.as_mut())
    .await?;
    let decisions: Decisions = if decisions.is_null() {
        Decisions::default()
    } else {
        serde_json::from_value(decisions)
            .map_err(|_| HrError::internal("import decisions invalid"))?
    };
    if !rows.iter().any(|row| {
        sources.get(&row.source_key).is_some_and(|source| {
            needs_confirmation(&source_input(source), &row.outcome, &decisions)
        })
    }) {
        return Ok(());
    }
    let confirmed = console_entity_adapter_postgres::name_evidence::company_candidates(tx, org)
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    let employees: Vec<_> = rows.iter().filter_map(|r| r.employee_id).collect();
    let placements = sqlx::query("SELECT DISTINCT ON (employee_id) employee_id, workplace_id FROM employment_assignments WHERE org_id = $1 AND employee_id = ANY($2) AND superseded_at IS NULL AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3) ORDER BY employee_id, valid_from DESC, created_at DESC")
        .bind(org).bind(&employees).bind(today_kst()).fetch_all(tx.as_mut()).await?;
    let placements: BTreeMap<Uuid, Option<Uuid>> = placements
        .into_iter()
        .map(|r| Ok((r.try_get("employee_id")?, r.try_get("workplace_id")?)))
        .collect::<Result<_, sqlx::Error>>()?;
    for row in rows {
        let Some(source) = sources.get(&row.source_key) else {
            continue;
        };
        let input = source_input(source);
        if !needs_confirmation(&input, &row.outcome, &decisions) {
            continue;
        }
        let candidates = super::company::proposals(&input, &confirmed);
        let workplace = row
            .employee_id
            .and_then(|id| placements.get(&id).copied().flatten());
        let employer = confirmed
            .iter()
            .find(|c| workplace.is_some_and(|id| c.workplaces.contains(&id)));
        row.company_confirmation = Some(CompanyConfirmation {
            value: input.company,
            registration_number: input.company_brn,
            source_column: source["source_metadata"]["company_column"]
                .as_str()
                .map(str::to_owned),
            cell: source["source_metadata"]["cells"]["company"]
                .as_str()
                .map(str::to_owned),
            candidates,
            confirmed_employer: employer.map(|c| c.name.clone()),
        });
    }
    Ok(())
}

fn source_input(source: &Value) -> ImportRow {
    ImportRow {
        company: source["company"].as_str().unwrap_or_default().to_owned(),
        company_brn: source["canonical"]["company_brn"]
            .as_str()
            .map(str::to_owned),
        ..Default::default()
    }
}
