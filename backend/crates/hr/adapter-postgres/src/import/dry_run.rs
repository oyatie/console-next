//! BW-10 6: the dry run plans every candidate row against the live roster —
//! insert, update with a field diff, unchanged, excluded with a reason, or
//! what is still unresolved — and stores the plan, its digest and the
//! operator's decisions on the run. Nothing is written to `employees`.
use crate::clock::today_kst;
use crate::digest::sha256_hex;
use crate::directory::access_log::import_rows_event;
use crate::directory::create::require_assignable_org_unit;
use crate::employee_number::facts::numbering;
use crate::import::apply::active_org_units_by_name;
use crate::import::apply_drive::refuse_while_running;
use crate::import::apply_job::require_row_limit;
use crate::import::identities;
use crate::import::plan_facts::{
    former_load_open, import_row, people_for_rows, placement_facts, units_named,
};
use crate::import::review::{check_import2_decisions, remembered_for_run, review_of};
use crate::import::store::{import_run_for_update, load_candidate_import_rows};
use crate::import::types::{
    CompanyImportSummary, DataImportRunRecord, EmployeeImportDryRunSummary, ImportDryRunRequest,
    StoredEmployeeImportRow,
};
use crate::lifecycle::title_reason::coded;
use crate::{HrError, HrService};
use console_entity_adapter_postgres::employment_moves::open_workplace_entity;
use console_hr_domain::import::plan::{Decisions, GROUP_ANSWERS, ImportRow, PlanFacts, PlannedRow};
use console_hr_domain::import::plan_group::group_key_ok;
use console_hr_domain::import::plan_rows::plan_rows;
use console_hr_domain::import::review::ReviewQueue;
use console_hr_domain::import::summary::{
    auto_mapped, employment_type_empty_rows, phone_unstored_rows, unplaced,
};
use console_hr_domain::profile::enums::EmploymentType;
use console_kernel_core::{KernelError, OrgId};
use console_platform_authz::Principal;
use console_platform_db::with_audit;
use console_settings_adapter_postgres::validate_reason_in_tx;
use console_settings_domain::code_lists::ReasonDomain;
use serde_json::json;
use sqlx::Postgres;
use std::collections::BTreeMap;
use uuid::Uuid;
/// The plan of a run's candidate rows with `decisions`, against the live roster.
pub async fn plan_run(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
    decisions: &Decisions,
) -> Result<
    (
        Vec<StoredEmployeeImportRow>,
        Vec<ImportRow>,
        Vec<PlannedRow>,
    ),
    HrError,
> {
    let stored = load_candidate_import_rows(tx, org_uuid, run_id).await?;
    let hashes = identities::run_hashes(tx, org_uuid, run_id).await?;
    let phones = crate::import::phones::run_keys(tx, org_uuid, run_id).await?;
    let rows: Vec<_> = stored
        .iter()
        .map(|row| import_row(row, (&hashes, &phones)))
        .collect();
    let people = people_for_rows(tx, org_uuid, &rows).await?;
    let units = units_named(active_org_units_by_name(tx).await?, &rows);
    let bindable = units
        .values()
        .flatten()
        .chain(decisions.unit_map.values().flatten());
    let (unit_workplaces, workplaces) = placement_facts(tx, org_uuid, bindable.copied()).await?;
    let numbering = numbering(tx, org_uuid).await?;
    let company_workplaces =
        crate::import::company::company_places(tx, org_uuid, decisions).await?;
    let facts = PlanFacts {
        company_workplaces: &company_workplaces,
        people: &people,
        units: &units,
        unit_workplaces: &unit_workplaces,
        workplaces: &workplaces,
        today: today_kst(),
        former_load_open: former_load_open(tx, org_uuid).await?,
        numbering: &numbering,
    };
    let planned = plan_rows(&rows, &facts, decisions);
    Ok((stored, rows, planned))
}
/// sha-256 of the planned rows as the dry run returned them.
pub fn plan_digest(rows: &[PlannedRow]) -> Result<String, HrError> {
    let bytes = serde_json::to_vec(rows)
        .map_err(|_| HrError::internal("import plan could not be serialized"))?;
    Ok(sha256_hex(&bytes))
}
/// Every decision names a row of this run; exclusion reasons are BW-07
/// `import_exclude` codes; mapped units are ACTIVE units of this tenant,
/// mapped 사업장 open ones, mapped 고용형태 known codes.
async fn check_decisions(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    stored: &[StoredEmployeeImportRow],
    decisions: &Decisions,
) -> Result<(), HrError> {
    let known = |key: &String| stored.iter().any(|row| &row.source_key == key);
    if let Some(key) = decisions
        .identity
        .keys()
        .chain(decisions.exclusions.keys())
        .find(|key| !known(key))
    {
        return Err(HrError::validation(format!(
            "decision names a row that is not in this run: {key}"
        )));
    }
    if let Some(key) = decisions.group_exclusions.keys().find(|k| !group_key_ok(k)) {
        return Err(HrError::validation(format!(
            "a group answer names no row-level reason: {key}"
        )));
    }
    // r3:hire-19: a conflict pattern's answer is one of its own.
    if let Some((key, answer)) = decisions.group_answers.iter().find(|(key, answer)| {
        !GROUP_ANSWERS
            .iter()
            .any(|(k, answers)| k == key && answers.contains(&answer.as_str()))
    }) {
        return Err(HrError::validation(format!(
            "group_answers.{key} cannot be {answer}"
        )));
    }
    for exclusion in decisions
        .exclusions
        .values()
        .chain(decisions.group_exclusions.values())
    {
        validate_reason_in_tx(
            tx.as_mut(),
            org,
            ReasonDomain::ImportExclude,
            exclusion.reason_code.trim(),
            exclusion.note.as_deref(),
        )
        .await
        .map_err(|error| {
            let code = error.code;
            let mut hr = HrError::from_kernel(error);
            if let Some(code) = code {
                hr.code = code;
            }
            hr
        })?;
    }
    for unit in decisions.unit_map.values().flatten() {
        require_assignable_org_unit(tx, *org.as_uuid(), *unit).await?;
    }
    for workplace in decisions.workplace_map.values().flatten() {
        open_workplace_entity(tx.as_mut(), *org.as_uuid(), *workplace)
            .await
            .map_err(coded)?;
    }
    for kind in decisions.employment_type_map.values().flatten() {
        EmploymentType::parse(kind)?;
    }
    check_import2_decisions(stored, decisions)
}
fn summarize(
    run_id: Uuid,
    run: &DataImportRunRecord,
    stored: &[StoredEmployeeImportRow],
    (import_rows, rows): (&[ImportRow], Vec<PlannedRow>),
    decisions: Decisions,
    dry_run_digest: String,
    review: ReviewQueue,
) -> EmployeeImportDryRunSummary {
    let count = |outcome: &str| rows.iter().filter(|row| row.outcome == outcome).count();
    let mut companies = BTreeMap::<String, CompanyImportSummary>::new();
    for (row, plan) in stored.iter().zip(&rows) {
        let entry = companies
            .entry(row.company.clone())
            .or_insert_with(|| CompanyImportSummary {
                company: row.company.clone(),
                ..CompanyImportSummary::default()
            });
        entry.input_rows += 1;
        match plan.outcome {
            "insert" => entry.inserted += 1,
            "update" => entry.updated += 1,
            _ => entry.skipped += 1,
        }
    }
    let inserts = || rows.iter().filter_map(|row| row.new_person.as_ref());
    let bound = inserts().filter(|p| p.org_unit_id.is_some()).count();
    let mut unresolved: Vec<String> = rows
        .iter()
        .filter_map(|row| row.unit_name.clone())
        .collect();
    unresolved.sort();
    unresolved.dedup();
    EmployeeImportDryRunSummary {
        run_id,
        input_rows: usize::try_from(run.input_rows).unwrap_or_default(),
        candidate_rows: usize::try_from(run.candidate_rows).unwrap_or_default(),
        preserved_rows: usize::try_from(run.preserved_rows).unwrap_or_default(),
        insert_candidates: count("insert"),
        update_candidates: count("update"),
        unchanged_rows: count("unchanged"),
        excluded_rows: count("excluded"),
        unsettled_rows: rows.iter().filter(|row| !row.is_settled()).count(),
        companies: companies.into_values().collect(),
        org_unit_bound_rows: bound,
        org_unit_unbound_rows: inserts().count() - bound,
        unresolved_org_units: unresolved,
        auto_mapped: auto_mapped(import_rows, &rows, &decisions),
        employment_type_empty_rows: employment_type_empty_rows(&rows),
        unplaced: unplaced(&rows),
        phone_unstored_rows: phone_unstored_rows(import_rows, &rows),
        dry_run_digest,
        decisions,
        rows,
        review,
        remembered: Vec::new(),
    }
}
impl HrService {
    /// Plans the run with the operator's decisions and stores the plan; may
    /// be called again (new decisions, or the roster moved) until apply.
    pub async fn dry_run_import(
        &self,
        principal: Principal,
        run_id: Uuid,
        request: ImportDryRunRequest,
    ) -> Result<EmployeeImportDryRunSummary, HrError> {
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let after = json!({ "run_id": run_id, "entity_type": "employee_hr" });
        let event = import_rows_event(&principal, "data_import.dry_run", run_id, after)?;
        let summary = with_audit::<_, _, HrError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let run = import_run_for_update(tx, org_uuid, run_id).await?;
                if run.entity_type != "employee_hr" {
                    return Err(HrError::validation(
                        "import run entity_type is not employee_hr",
                    ));
                }
                if run.status != "PREVIEWED" && run.status != "DRY_RUN" {
                    return Err(HrError::from_kernel(KernelError::invalid_transition(
                        format!("cannot dry-run import run in {} status", run.status),
                    )));
                }
                identities::require_fresh_run(tx, org_uuid, run_id).await?;
                refuse_while_running(tx, org_uuid, run_id).await?;
                require_row_limit(tx, org_uuid, run_id).await?;
                let operator = request.decisions;
                let stored = load_candidate_import_rows(tx, org_uuid, run_id).await?;
                check_decisions(tx, org, &stored, &operator).await?;
                let (decisions, remembered) =
                    remembered_for_run(tx, org_uuid, &stored, &operator).await?;
                let (stored, import_rows, rows) =
                    plan_run(tx, org_uuid, run_id, &decisions).await?;
                let digest = plan_digest(&rows)?;
                let review = review_of(
                    tx,
                    org_uuid,
                    run_id,
                    &stored,
                    &import_rows,
                    &rows,
                    &decisions,
                )
                .await?;
                let mut summary = summarize(
                    run_id,
                    &run,
                    &stored,
                    (&import_rows, rows),
                    decisions,
                    digest,
                    review,
                );
                summary.remembered = remembered;
                sqlx::query(
                    "UPDATE data_import_runs SET status = 'DRY_RUN', dry_run_summary = $3, \
                            dry_run_digest = $4, dry_run_decisions = $5, updated_at = now() \
                     WHERE org_id = $1 AND id = $2",
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(json!(&summary))
                .bind(&summary.dry_run_digest)
                .bind(json!(&summary.decisions))
                .execute(tx.as_mut())
                .await?;
                Ok(summary)
            })
        })
        .await?;
        metrics::counter!("hr_data_import_runs_total", "stage" => "dry_run").increment(1);
        Ok(summary)
    }
}
