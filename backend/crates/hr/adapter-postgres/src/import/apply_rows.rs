//! BW-10 the rows the leave command applies, built from a checked plan:
//! `insert` with every value of the new person (the 사번 the plan previewed,
//! or none: 「사번 미부여」), `update` with only the fields import may write.
//! Unchanged and excluded rows are not sent.

use std::collections::BTreeMap;

use console_hr_domain::import::plan::{NewPerson, PlannedRow};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::import::company::company_of;
use crate::import::types::StoredEmployeeImportRow;

/// The 이관 mark of a former employee and the unit name that bound no unit
/// (「미배치 · 원본 부서」, kept on the person: MR-7).
fn metadata(person: &NewPerson, source: &StoredEmployeeImportRow) -> Value {
    let mut metadata = Map::new();
    if person.migrated_former {
        metadata.insert("migrated_former_employee".into(), json!(true));
    }
    if let Some(name) = &person.unresolved_org_unit {
        metadata.insert("unresolved_org_unit".into(), json!(name));
    }
    if person.workplace_id.is_none()
        && person.status != "EXITED"
        && let Some(name) = &source.canonical.workplace
    {
        metadata.insert("unresolved_workplace".into(), json!(name));
    }
    Value::Object(metadata)
}

/// The p_rows of `leave_api.apply_employee_import_batch` v2. Every 사번 is
/// the one the dry run showed (IMPORT-2: assigned in the plan, never here);
/// a person recorded 휴직 is inserted current and the settle records the
/// 휴직 from its start date (decisions #26).
/// `entities` names the 법인 of each 사업장 the plan places someone at
/// (`company::entity_names`): a new person's 법인 text (r3:hire-01).
pub fn batch_rows(
    stored: &[StoredEmployeeImportRow],
    plan: &[PlannedRow],
    entities: &BTreeMap<Uuid, String>,
) -> Value {
    let mut items = Vec::new();
    for (source, row) in stored.iter().zip(plan) {
        match (row.outcome, &row.new_person, row.employee_id) {
            ("insert", Some(person), _) => {
                items.push(json!({
                    "action": "insert",
                    "source_key": row.source_key,
                    "employee_number": person.employee_number,
                    "name": row.name,
                    "company": company_of(person.workplace_id, entities),
                    "status": if person.status == "ON_LEAVE" { "ACTIVE" } else { person.status },
                    "hire_date": person.hire_date,
                    "exit_date": person.exit_date,
                    "birth_date": person.birth_date,
                    "org_unit": person.org_unit,
                    "org_unit_id": person.org_unit_id,
                    "job": source.canonical.job,
                    "position": source.canonical.position,
                    "worksite_name": source.canonical.worksite_name,
                    "worksite_address": source.canonical.worksite_address,
                    "metadata": metadata(person, source),
                }));
            }
            ("update", _, Some(employee_id)) => {
                // 고용형태 lives on the employment profile: the settle step
                // writes it (MR-7), the batch only the employee columns.
                let set: Map<String, Value> = row
                    .diff
                    .iter()
                    .filter(|change| change.field != "employment_type")
                    .map(|change| (change.field.to_owned(), json!(change.to)))
                    .collect();
                items.push(json!({
                    "action": "update",
                    "source_key": row.source_key,
                    "name": row.name,
                    "employee_id": employee_id,
                    "employee_number": row.employee_number,
                    "expected_updated_at": row.observed,
                    "set": set,
                }));
            }
            _ => {}
        }
    }
    Value::Array(items)
}
