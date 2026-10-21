//! Reads: one employee's entries, one entry's history, and the per-section
//! sheet export (사번 + entry id + version) that the import sheet takes back
//! for bulk corrections and voids.

use console_hr_domain::record::Section;
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::person::bound_person;
use super::store;
use super::support::view;
use super::switch::section_states;
use super::{RecordEntryView, RecordHistory, RecordList, RecordPurpose, RecordRevisionView};
use crate::authz::{authorize_hr_org_wide, authorize_hr_person, hr_reach};
use crate::metrics::record_hr_read;
use crate::paging::MAX_LIMIT;
use crate::{HrError, HrService};

/// One row of `GET /employee-records/{section}`.
#[derive(Debug, Clone, Serialize)]
pub struct SectionSheetRow {
    pub employee_id: Uuid,
    pub employee_number: Option<String>,
    pub employee_name: String,
    pub entry: RecordEntryView,
}

#[derive(Debug, Clone, Serialize)]
pub struct SectionSheet {
    pub items: Vec<SectionSheetRow>,
    /// Pass as `after` for the next page; `None` on the last page.
    pub next_after: Option<Uuid>,
}

impl HrService {
    pub async fn employee_records(
        &self,
        principal: Principal,
        employee: Uuid,
        section: Option<Section>,
        include_voided: bool,
        purpose: Option<RecordPurpose>,
    ) -> Result<RecordList, HrError> {
        if let Some(section) = section.filter(|s| s.restricted()) {
            return self
                .restricted_records(principal, employee, section, include_voided, purpose)
                .await;
        }
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        record_hr_read("employee_records");
        let org = principal.org_id;
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee)
                    .await?;
                let org_uuid = *org.as_uuid();
                let sections = section_states(tx).await?;
                let items = match bound_person(tx, org_uuid, employee).await? {
                    None => Vec::new(),
                    Some(person) => store::load_current(tx, org_uuid, &[person], section)
                        .await?
                        .into_iter()
                        // Restricted sections only through their purposed read.
                        .filter(|c| !c.section.restricted())
                        .filter(|c| include_voided || !c.voided())
                        .map(view)
                        .collect(),
                };
                Ok(RecordList { sections, items })
            })
        })
        .await
    }

    pub async fn record_history(
        &self,
        principal: Principal,
        employee: Uuid,
        section: Section,
        entry: Uuid,
        purpose: Option<RecordPurpose>,
    ) -> Result<RecordHistory, HrError> {
        if section.restricted() {
            return self
                .restricted_history(principal, employee, section, entry, purpose)
                .await;
        }
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        record_hr_read("employee_record_history");
        let org = principal.org_id;
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let manage = Feature::EmployeeDirectoryManage;
                authorize_hr_person(tx, &principal, manage, employee).await?;
                history_in_tx(tx, *org.as_uuid(), employee, section, entry).await
            })
        })
        .await
    }

    /// Live entries of one section across the tenant, by entry id, one row
    /// per entry under the bound employee with the lowest 사번.
    pub async fn record_section_sheet(
        &self,
        principal: Principal,
        section: Section,
        after: Option<Uuid>,
        limit: Option<i64>,
    ) -> Result<SectionSheet, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        if section.restricted() {
            // a bulk read of 민감/징계 needs the per-export 결재 tier
            // (access-model GR-25), which is not built; until then the sheet
            // is refused and bulk corrections take entry ids from the
            // purposed one-by-one read.
            return Err(HrError {
                status: http::StatusCode::CONFLICT,
                code: "record_restricted_export_unavailable",
                message: "a restricted section cannot be exported as a sheet".to_owned(),
                refusals: None,
            });
        }
        record_hr_read("employee_record_sheet");
        let limit = limit.unwrap_or(MAX_LIMIT).clamp(1, MAX_LIMIT);
        let org = principal.org_id;
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let org_uuid = *org.as_uuid();
                let rows = sqlx::query(
                    "SELECT e.id, e.person_id, em.id AS employee_id, em.employee_number, em.name FROM person_record_entries e \
                     JOIN LATERAL (SELECT kind FROM person_record_revisions r WHERE r.org_id = e.org_id \
                       AND r.entry_id = e.id ORDER BY r.version DESC LIMIT 1) head ON head.kind <> 'VOID' \
                     JOIN LATERAL (SELECT x.id, x.employee_number, x.name FROM employee_person_bindings b \
                       JOIN employees x ON x.org_id = b.org_id AND x.id = b.employee_id \
                       WHERE b.org_id = e.org_id AND b.person_id = e.person_id \
                       ORDER BY x.employee_number NULLS LAST, x.id LIMIT 1) em ON true \
                     WHERE e.org_id = $1 AND e.section = $2 AND ($3::uuid IS NULL OR e.id > $3) \
                     ORDER BY e.id LIMIT $4",
                )
                .bind(org_uuid)
                .bind(section.as_str())
                .bind(after)
                .bind(limit + 1)
                .fetch_all(tx.as_mut())
                .await?;
                let more = rows.len() as i64 > limit;
                let rows = &rows[..rows.len().min(limit as usize)];
                let ids = rows.iter().map(|r| r.try_get("id")).collect::<Result<Vec<Uuid>, _>>()?;
                let persons = rows.iter().map(|r| r.try_get("person_id")).collect::<Result<Vec<Uuid>, _>>()?;
                let mut heads: std::collections::HashMap<Uuid, _> =
                    store::load_current(tx, org_uuid, &persons, Some(section))
                        .await?
                        .into_iter()
                        .map(|c| (c.head.entry_id, c))
                        .collect();
                let mut items = Vec::with_capacity(rows.len());
                for (row, entry) in rows.iter().zip(ids) {
                    let current = heads
                        .remove(&entry)
                        .ok_or_else(|| HrError::internal("listed entry was not read back"))?;
                    items.push(SectionSheetRow {
                        employee_id: row.try_get("employee_id")?,
                        employee_number: row.try_get("employee_number")?,
                        employee_name: row.try_get("name")?,
                        entry: view(current),
                    });
                }
                let next_after = more.then(|| items.last().map(|r| r.entry.id)).flatten();
                Ok(SectionSheet { items, next_after })
            })
        })
        .await
    }
}

/// One entry's revisions, oldest first, checked against the employee's person
/// and the section (404 otherwise).
pub(super) async fn history_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee: Uuid,
    section: Section,
    entry: Uuid,
) -> Result<RecordHistory, HrError> {
    let not_found = || HrError::from_kernel(KernelError::not_found("record entry was not found"));
    let person = bound_person(tx, org_uuid, employee)
        .await?
        .ok_or_else(not_found)?;
    store::load_entry(tx, org_uuid, entry)
        .await?
        .filter(|c| c.person_id == person && c.section == section)
        .ok_or_else(not_found)?;
    let revisions = store::load_revisions(tx, org_uuid, entry)
        .await?
        .into_iter()
        .map(|r| RecordRevisionView {
            actor_kind: r.actor_kind,
            command_id: r.command_id,
            version: r.version,
            kind: r.kind,
            source: r.source,
            reason: r.reason,
            actor_id: r.actor_id,
            fields: r.fields,
            created_at: r.created_at,
        })
        .collect();
    Ok(RecordHistory {
        entry_id: entry,
        section,
        revisions,
    })
}
