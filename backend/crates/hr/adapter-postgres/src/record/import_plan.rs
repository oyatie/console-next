//! The per-section import sheet plan: each row resolved to an employee by 사번
//! and decided by `console_hr_domain::record::plan::decide`. Preview and apply
//! compute the same plan; apply runs only when its digest still matches.

use std::collections::{BTreeSet, HashMap, HashSet};

use console_hr_domain::record::plan::{Decision, EntryFact, RowIntent, decide};
use console_hr_domain::record::{RecordFields, Section, validate_reason};
use console_platform_authz::cedar_pbac::actions::employee_restricted_record::Operation;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::import::{ImportRow, ImportRowResult};
use super::parse_fields;
use super::restricted::Gate;
use super::store;
use super::support::digest;
use crate::HrError;

/// One row with everything apply needs.
pub(crate) struct PlannedRow {
    pub employee: Option<Uuid>,
    pub person: Option<Uuid>,
    pub decision: Decision,
    pub fields: Option<RecordFields>,
    pub reason: Option<String>,
    pub message: Option<String>,
}

pub(crate) struct Plan {
    pub rows: Vec<PlannedRow>,
    pub digest: Vec<u8>,
}

impl Plan {
    /// The employees whose person apply must mint (if unbound) and lock.
    pub fn writers(&self) -> BTreeSet<Uuid> {
        self.rows
            .iter()
            .filter(|r| {
                !matches!(
                    r.decision,
                    Decision::Error { .. } | Decision::Unchanged { .. }
                )
            })
            .filter_map(|r| r.employee)
            .collect()
    }
}

fn error(code: &'static str, message: Option<String>) -> PlannedRow {
    PlannedRow {
        employee: None,
        person: None,
        decision: Decision::Error { code },
        fields: None,
        reason: None,
        message,
    }
}

async fn employees_by_number(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    numbers: &[String],
) -> Result<HashMap<String, Vec<Uuid>>, HrError> {
    let rows = sqlx::query(
        "SELECT id, btrim(employee_number) AS number FROM employees \
         WHERE org_id = $1 AND btrim(employee_number) = ANY($2)",
    )
    .bind(org)
    .bind(numbers)
    .fetch_all(tx.as_mut())
    .await?;
    let mut out: HashMap<String, Vec<Uuid>> = HashMap::new();
    for row in rows {
        out.entry(row.try_get("number")?)
            .or_default()
            .push(row.try_get("id")?);
    }
    Ok(out)
}

/// Existing Person bindings; a record import never invents a human.
async fn persons_of(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employees: &[Uuid],
) -> Result<HashMap<Uuid, Uuid>, HrError> {
    let rows = sqlx::query(
        "SELECT employee_id, person_id FROM employee_person_bindings WHERE org_id = $1 AND employee_id = ANY($2)",
    )
    .bind(org)
    .bind(employees)
    .fetch_all(tx.as_mut())
    .await?;
    let mut out: HashMap<Uuid, Uuid> = HashMap::new();
    for row in rows {
        out.insert(row.try_get("employee_id")?, row.try_get("person_id")?);
    }
    Ok(out)
}

/// A refused row: its code and, for a field rule, the rule's message.
type Refusal = (&'static str, Option<String>);

fn intent(section: Section, row: &ImportRow) -> Result<(RowIntent, Option<String>), Refusal> {
    if let Some(reason) = &row.void_reason {
        let entry_id = row.entry_id.ok_or(("void_needs_entry", None))?;
        let reason = validate_reason(Some(reason.clone()), true)
            .map_err(|e| ("invalid_reason", Some(e.message)))?;
        let expected_version = row.expected_version;
        return Ok((
            RowIntent::Void {
                entry_id,
                expected_version,
            },
            reason,
        ));
    }
    let raw = row.fields.clone().ok_or(("fields_required", None))?;
    let fields = parse_fields(section, raw).map_err(|e| ("invalid_fields", Some(e.message)))?;
    Ok(match row.entry_id {
        None => (RowIntent::Create(fields), None),
        Some(entry_id) => {
            let expected_version = row.expected_version;
            (
                RowIntent::Update {
                    entry_id,
                    expected_version,
                    fields,
                },
                None,
            )
        }
    })
}

/// Compute the plan for `rows` in `section` against the tenant as it is now.
/// A restricted section passes its `gate`: each row is decided by Cedar for
/// its own subject (`restricted_denied` when refused, e.g. one's own record).
pub(crate) async fn plan(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    section: Section,
    rows: &[ImportRow],
    gate: Option<&Gate>,
) -> Result<Plan, HrError> {
    let numbers: Vec<String> = rows
        .iter()
        .map(|r| r.employee_number.trim().to_owned())
        .collect();
    let by_number = employees_by_number(tx, org, &numbers).await?;
    let employees: Vec<Uuid> = by_number.values().flatten().copied().collect();
    let persons = persons_of(tx, org, &employees).await?;
    let person_ids: Vec<Uuid> = persons
        .values()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let facts: Vec<EntryFact> = store::load_current(tx, org, &person_ids, Some(section))
        .await?
        .into_iter()
        .map(|c| EntryFact {
            entry_id: c.head.entry_id,
            person_id: c.person_id,
            section: c.section,
            version: c.head.version,
            voided: c.voided(),
            fields: c.head.fields,
        })
        .collect();
    let mut claimed: HashSet<String> = HashSet::new();
    let mut planned = Vec::with_capacity(rows.len());
    for (row, number) in rows.iter().zip(&numbers) {
        let employee = match by_number.get(number).map(Vec::as_slice) {
            None | Some([]) => {
                planned.push(error("employee_not_found", None));
                continue;
            }
            Some([one]) => *one,
            Some(_) => {
                planned.push(error("employee_number_ambiguous", None));
                continue;
            }
        };
        let Some(person) = persons.get(&employee).copied() else {
            planned.push(error("person_binding_required", None));
            continue;
        };
        let (intent, reason) = match intent(section, row) {
            Ok(parsed) => parsed,
            Err((code, message)) => {
                planned.push(PlannedRow {
                    employee: Some(employee),
                    ..error(code, message)
                });
                continue;
            }
        };
        let op = match intent {
            RowIntent::Void { .. } => Operation::Void,
            _ => Operation::Write,
        };
        if gate.is_some_and(|g| g.decide(op, employee, Some(person)).is_err()) {
            planned.push(PlannedRow {
                employee: Some(employee),
                ..error("restricted_denied", None)
            });
            continue;
        }
        let target = match &intent {
            RowIntent::Update { entry_id, .. } | RowIntent::Void { entry_id, .. } => {
                facts.iter().find(|f| f.entry_id == *entry_id)
            }
            RowIntent::Create(_) => None,
        };
        let live: Vec<EntryFact> = facts
            .iter()
            .filter(|f| f.person_id == person && !f.voided)
            .cloned()
            .collect();
        let mut decision = decide(section, person, &intent, target, &live);
        // One row per entry, and one new 병역 entry per person, per sheet.
        let fields = match intent {
            RowIntent::Create(f) | RowIntent::Update { fields: f, .. } => Some(f),
            RowIntent::Void { .. } => None,
        };
        let key = match (&decision, &fields) {
            (
                Decision::Update { entry_id, .. }
                | Decision::Void { entry_id, .. }
                | Decision::Unchanged { entry_id },
                _,
            ) => Some(entry_id.to_string()),
            (Decision::Create, _) if section.single_live() => Some(format!("person:{person}")),
            (Decision::Create, Some(f)) => Some(format!(
                "{person}:{}",
                hex::encode(digest(&serde_json::json!(f)))
            )),
            _ => None,
        };
        if key.is_some_and(|k| !claimed.insert(k)) {
            decision = Decision::Error {
                code: "duplicate_in_sheet",
            };
        }
        planned.push(PlannedRow {
            employee: Some(employee),
            person: Some(person),
            decision,
            fields,
            reason,
            message: None,
        });
    }
    let summary: Vec<ImportRowResult> = rows
        .iter()
        .zip(&planned)
        .map(|(r, p)| ImportRowResult::of(r.row, p))
        .collect();
    let digest = digest(&serde_json::json!({
        "section": section.as_str(),
        "rows": rows,
        "plan": summary,
    }));
    Ok(Plan {
        rows: planned,
        digest,
    })
}
