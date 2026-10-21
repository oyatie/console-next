//! IMPORT-2: the dry run's decisions beyond BW-10 — checking the new maps,
//! filling unanswered ones from the tenant's memory (only for texts this run
//! has, only records still usable), and the 「확인 필요」 queue of the plan.

use std::collections::{BTreeMap, BTreeSet};

use console_entity_adapter_postgres::employment_hire::open_workplaces;
use console_entity_adapter_postgres::employment_moves::open_workplace_entity;
use console_hr_domain::import::names::with_candidates;
use console_hr_domain::import::normalize::known_code;
use console_hr_domain::import::plan::{Decisions, ImportRow, PlannedRow};
use console_hr_domain::import::review::{ReviewQueue, review_queue};
use serde_json::Value;
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::directory::create::require_assignable_org_unit;
use crate::import::apply::active_org_units_by_name;
use crate::import::memory::{merge, remembered_values};
use crate::import::preview::notes_from;
use crate::import::types::{RememberedEntry, StoredEmployeeImportRow};
use crate::lifecycle::title_reason::coded;

type Tx<'a, 'b> = &'a mut sqlx::Transaction<'b, Postgres>;

/// The status, leave-type and 사번 answers name known codes and rows.
///
/// # Errors
/// 400 for an unknown code, a 사번 answer for a row not in the run, or a
/// blank / overlong 사번.
pub fn check_import2_decisions(
    stored: &[StoredEmployeeImportRow],
    decisions: &Decisions,
) -> Result<(), HrError> {
    if let Some(code) = decisions
        .status_map
        .values()
        .find(|code| known_code("status", code).is_none())
    {
        return Err(HrError::validation(format!("unknown status code: {code}")));
    }
    if let Some(code) = decisions
        .leave_type_map
        .values()
        .find(|code| known_code("leave_type", code).is_none())
    {
        return Err(HrError::validation(format!("unknown leave type: {code}")));
    }
    for (key, number) in &decisions.employee_numbers {
        if !stored.iter().any(|row| &row.source_key == key) {
            return Err(HrError::validation(format!(
                "decision names a row that is not in this run: {key}"
            )));
        }
        let number = number.trim();
        if number.is_empty() || number.chars().count() > 40 {
            return Err(HrError::validation(
                "a 사번 answer is blank or longer than 40",
            ));
        }
    }
    Ok(())
}

/// The operator's decisions with the remembered answers for this run's
/// texts that the operator did not give.
pub async fn remembered_for_run(
    tx: Tx<'_, '_>,
    org: Uuid,
    stored: &[StoredEmployeeImportRow],
    operator: &Decisions,
) -> Result<(Decisions, Vec<RememberedEntry>), HrError> {
    let texts = |pick: fn(&StoredEmployeeImportRow) -> Option<&String>| -> BTreeSet<String> {
        stored.iter().filter_map(pick).cloned().collect()
    };
    let units = texts(|r| r.canonical.org_unit.as_ref());
    let places = texts(|r| r.canonical.worksite_name.as_ref());
    let kinds = texts(|r| r.canonical.employment_type.as_ref());
    let statuses = texts(|r| r.canonical.status.as_ref());
    let mut leaves = texts(|r| r.canonical.leave_type.as_ref());
    leaves.insert(String::new());
    let mut memory = remembered_values(tx, org).await?;
    memory.unit_map.retain(|k, _| units.contains(k));
    memory.workplace_map.retain(|k, _| places.contains(k));
    memory.employment_type_map.retain(|k, _| kinds.contains(k));
    memory.status_map.retain(|k, _| statuses.contains(k));
    memory.leave_type_map.retain(|k, _| leaves.contains(k));
    let mut usable = BTreeMap::new();
    for (text, id) in std::mem::take(&mut memory.unit_map) {
        let ok = match id {
            Some(unit) => require_assignable_org_unit(tx, org, unit).await.is_ok(),
            None => true,
        };
        if ok {
            usable.insert(text, id);
        }
    }
    memory.unit_map = usable;
    let mut usable = BTreeMap::new();
    for (text, id) in std::mem::take(&mut memory.workplace_map) {
        let ok = match id {
            Some(place) => open_workplace_entity(tx.as_mut(), org, place).await.is_ok(),
            None => true,
        };
        if ok {
            usable.insert(text, id);
        }
    }
    memory.workplace_map = usable;
    let (merged, used) = merge(operator, memory);
    let used = used
        .into_iter()
        .map(|(decision, key)| RememberedEntry { decision, key })
        .collect();
    Ok((merged, used))
}

/// The queue of the planned run: its parse notes plus the plan's items.
pub async fn review_of(
    tx: Tx<'_, '_>,
    org: Uuid,
    run: Uuid,
    stored: &[StoredEmployeeImportRow],
    rows: &[ImportRow],
    plans: &[PlannedRow],
    decisions: &Decisions,
) -> Result<ReviewQueue, HrError> {
    let profile: Value = sqlx::query_scalar(
        "SELECT mapping_profile FROM data_import_runs WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(run)
    .fetch_one(tx.as_mut())
    .await?;
    let cells: BTreeMap<&str, &Value> = stored
        .iter()
        .map(|row| (row.source_key.as_str(), &row.source_metadata["cells"]))
        .collect();
    let cell = |key: &str, field: &str| {
        cells
            .get(key)
            .and_then(|c| c[field].as_str())
            .map(ToOwned::to_owned)
    };
    let mut queue = review_queue(rows, plans, &notes_from(&profile), &cell);
    console_hr_domain::import::company_review::append_company_review(
        &mut queue, rows, plans, decisions, &cell,
    );
    let confirmed = console_entity_adapter_postgres::name_evidence::company_candidates(tx, org)
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    for item in queue
        .items
        .iter_mut()
        .filter(|i| i.reason == "company_unconfirmed")
    {
        let row = rows
            .iter()
            .find(|r| r.sheet == item.sheet && Some(r.row) == item.row);
        item.source_column = row
            .and_then(|r| stored.iter().find(|s| s.source_key == r.source_key))
            .and_then(|s| s.source_metadata["company_column"].as_str())
            .map(str::to_owned);
        if let Some(row) = row {
            item.candidates = super::company::proposals(row, &confirmed);
        }
    }
    // W03: every unit and 사업장 of the tenant, not only the names the rows used.
    let units = active_org_units_by_name(tx).await?;
    let mut workplaces = BTreeMap::<String, Vec<Uuid>>::new();
    for (name, id) in open_workplaces(tx.as_mut(), org).await.map_err(coded)? {
        workplaces.entry(name).or_default().push(id);
    }
    with_candidates(&mut queue, &units, &workplaces);
    Ok(queue)
}
