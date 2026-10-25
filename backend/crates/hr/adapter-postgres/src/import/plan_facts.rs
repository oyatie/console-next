//! BW-10 the facts a run is planned against, read in the caller's armed
//! transaction: its candidate rows, the people they may be (by 사번 or by
//! name), the ACTIVE units by name, and whether former employees may still be
//! loaded (no payroll period approved yet, W-05).

use std::collections::{BTreeMap, BTreeSet};

use console_entity_adapter_postgres::employment_hire::{open_workplaces, unit_placement};
use console_hr_domain::import::cells::{name_key, parse_import_date};
use console_hr_domain::import::plan::{ImportRow, OnFile};
use sqlx::Postgres;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::HrError;
use crate::import::types::StoredEmployeeImportRow;
use crate::lifecycle::title_reason::coded;

/// A stored candidate row as the planner reads it; `hashes` are the run's
/// staged 주민등록번호 keyed hashes by `source_key`, `phones` the rows with a
/// staged 휴대전화.
pub fn import_row(
    stored: &StoredEmployeeImportRow,
    (hashes, phones): (&BTreeMap<String, Vec<u8>>, &BTreeSet<String>),
) -> ImportRow {
    let fields = &stored.canonical;
    let text = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    ImportRow {
        source_key: stored.source_key.clone(),
        sheet: stored.source_sheet.clone(),
        row: stored.source_row,
        name: stored.name.trim().to_owned(),
        company: stored.company.trim().to_owned(),
        company_brn: text(&fields.company_brn),
        employee_number: text(&fields.employee_number),
        hire_date: text(&fields.hire_date),
        exit_date: text(&fields.exit_date),
        birth_date: text(&fields.birth_date),
        org_unit: text(&fields.org_unit),
        job: text(&fields.job),
        position: text(&fields.position),
        workplace: fields.workplace_text().cloned(),
        worksite_name: text(&fields.worksite_name),
        worksite_address: text(&fields.worksite_address),
        employment_type: text(&fields.employment_type),
        status: text(&fields.status),
        leave_start_date: text(&fields.leave_start_date),
        leave_type: text(&fields.leave_type),
        leave_return_date: text(&fields.leave_return_date),
        rrn_hmac: hashes.get(&stored.source_key).cloned(),
        has_phone: phones.contains(&stored.source_key),
        sex: text(&fields.sex),
        contract_end_date: text(&fields.contract_end_date),
        probation_end_date: text(&fields.probation_end_date),
    }
}

#[derive(sqlx::FromRow)]
struct PersonRow {
    id: Uuid,
    employee_number: Option<String>,
    name: String,
    employment_status: String,
    company: String,
    workplace_id: Option<Uuid>,
    birth_date: Option<time::Date>,
    hire_date: Option<String>,
    exit_date: Option<String>,
    org_unit: Option<String>,
    job: Option<String>,
    position: Option<String>,
    worksite_name: Option<String>,
    worksite_address: Option<String>,
    updated_at: OffsetDateTime,
    starts: Vec<String>,
    employment_type: Option<String>,
    rrn_hmac: Option<Vec<u8>>,
    aliases: Vec<String>,
}

/// The people the rows may be: every holder of a 사번 in the file (current
/// or as an alias), every person whose 주민등록번호 hash a row carries, and
/// every namesake (spaces ignored) of a row. Merged-away rows are not people.
pub async fn people_for_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    rows: &[ImportRow],
) -> Result<Vec<OnFile>, HrError> {
    let numbers: Vec<&str> = rows
        .iter()
        .filter_map(|row| row.employee_number.as_deref())
        .collect();
    let names: Vec<String> = rows.iter().map(|row| name_key(&row.name)).collect();
    let hashes: Vec<&[u8]> = rows
        .iter()
        .filter_map(|row| row.rrn_hmac.as_deref())
        .collect();
    let found: Vec<PersonRow> = sqlx::query_as(concat!(
        "SELECT e.id, e.employee_number, e.name, e.employment_status, e.company, e.birth_date, \
                e.hire_date::TEXT AS hire_date, e.exit_date::TEXT AS exit_date, e.org_unit, e.job, \
                e.position, e.worksite_name, e.worksite_address, e.updated_at, \
                ARRAY(SELECT l.effective_date::TEXT FROM employee_lifecycle_events l \
                      WHERE l.org_id = e.org_id AND l.employee_id = e.id \
                        AND l.event_type IN ('ONBOARD', 'REHIRE') \
                        AND l.state IN ('APPLIED', 'SCHEDULED')) AS starts, \
                p.employment_type, r.rrn_hmac, ea.workplace_id, \
                ARRAY(SELECT c.from_number FROM employee_number_changes c \
                      WHERE c.org_id = e.org_id AND c.employee_id = e.id \
                        AND c.undone_at IS NULL AND c.from_number IS NOT NULL) AS aliases \
         FROM person_employees_current e \
         LEFT JOIN employee_employment_profiles p ON p.org_id = e.org_id AND p.employee_id = e.id \
         LEFT JOIN employee_rrn r ON r.org_id = e.org_id AND r.employee_id = e.id \
         ",
        crate::assignment_lateral!(),
        "         WHERE e.org_id = $1 AND e.merged_into_employee_id IS NULL \
           AND (e.employee_number = ANY($2) \
                OR regexp_replace(e.name, '\\s', '', 'g') = ANY($3) \
                OR r.rrn_hmac = ANY($4) \
                OR EXISTS (SELECT 1 FROM employee_number_changes c \
                           WHERE c.org_id = e.org_id AND c.employee_id = e.id \
                             AND c.undone_at IS NULL AND c.from_number = ANY($2))) \
         ORDER BY e.created_at, e.id",
    ))
    .bind(org_uuid)
    .bind(&numbers)
    .bind(&names)
    .bind(&hashes)
    .fetch_all(tx.as_mut())
    .await?;
    found
        .into_iter()
        .map(|p| {
            let mut period_starts: Vec<time::Date> = p
                .starts
                .iter()
                .chain(p.hire_date.iter())
                .filter_map(|day| parse_import_date(day))
                .collect();
            period_starts.sort();
            period_starts.dedup();
            Ok(OnFile {
                id: p.id,
                employee_number: p.employee_number,
                name: p.name,
                status: p.employment_status,
                company: p.company,
                workplace_id: p.workplace_id,
                birth_date: p.birth_date,
                period_starts,
                exit_date: p.exit_date.as_deref().and_then(parse_import_date),
                org_unit: p.org_unit,
                job: p.job,
                position: p.position,
                worksite_name: p.worksite_name,
                worksite_address: p.worksite_address,
                employment_type: p.employment_type,
                observed: p
                    .updated_at
                    .format(&Rfc3339)
                    .map_err(|_| HrError::internal("employee updated_at is not formattable"))?,
                rrn_hmac: p.rrn_hmac,
                aliases: p.aliases,
            })
        })
        .collect()
}

/// W-05: former employees load as EXITED only before the tenant's first
/// approved (or issued) payroll period.
pub async fn former_load_open(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
) -> Result<bool, HrError> {
    Ok(sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM payroll_draft_runs \
          WHERE org_id = $1 AND status IN ('APPROVED', 'ISSUED'))",
    )
    .bind(org_uuid)
    .fetch_one(tx.as_mut())
    .await?)
}

/// Unit name → ids, narrowed to the names the rows use (the unit map's own
/// names come from the operator and are checked one by one).
pub fn units_named(
    all: BTreeMap<String, Vec<Uuid>>,
    rows: &[ImportRow],
) -> BTreeMap<String, Vec<Uuid>> {
    all.into_iter()
        .filter(|(name, _)| rows.iter().any(|row| row.org_unit.as_ref() == Some(name)))
        .collect()
}

/// MR-7: where the units the plan may bind sit (unit id → open 사업장, itself
/// or an ancestor) and every open 사업장 by name, through the entity owner.
pub async fn placement_facts(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    units: impl Iterator<Item = Uuid>,
) -> Result<(BTreeMap<Uuid, Uuid>, BTreeMap<String, Vec<Uuid>>), HrError> {
    let mut at = BTreeMap::new();
    for unit in units {
        if let Some(placed) = unit_placement(tx.as_mut(), org_uuid, unit)
            .await
            .map_err(coded)?
        {
            at.insert(unit, placed.workplace_id);
        }
    }
    let mut named = BTreeMap::<String, Vec<Uuid>>::new();
    for (name, id) in open_workplaces(tx.as_mut(), org_uuid)
        .await
        .map_err(coded)?
    {
        named.entry(name).or_default().push(id);
    }
    Ok((at, named))
}
