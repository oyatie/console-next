//! The per-section import sheet (bulk create, correct and void). The browser
//! parses the sheet (no file and no RRN column reaches the server) and sends
//! typed rows keyed by 사번. Preview writes nothing; apply is bound to the
//! preview's `plan_digest`, applies every valid row (partial apply), skips
//! the rest with their codes, and replays its report for a repeated
//! Idempotency-Key. Rows that carry `entry_id` (from the section sheet
//! export) correct or void that entry.
//!
//! not wired into the import run wizard / 이관 확인 funnel (IMPORT
//! lane's `import_runs`); add a sheet role there when that model is on trunk.

use console_hr_domain::record::plan::Decision;
use console_hr_domain::record::{RevisionKind, Section};
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::import_plan::{Plan, PlannedRow, plan};
use super::person::writable_person;
use super::restricted::gate;
use super::store;
use super::store_write::{NewRevision, insert_revision};
use super::support::{audit, digest};
use super::switch::require_enabled;
use crate::authz::authorize_hr_org_wide;
use crate::idempotency::idempotency_key_reused;
use crate::paging::MAX_LIMIT;
use crate::{HrError, HrService};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRow {
    /// The sheet row number, echoed in the report.
    pub row: u32,
    pub employee_number: String,
    #[serde(default)]
    pub entry_id: Option<Uuid>,
    #[serde(default)]
    pub expected_version: Option<i64>,
    /// Set (with `entry_id`) to void that entry.
    #[serde(default)]
    pub void_reason: Option<String>,
    #[serde(default)]
    pub fields: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportSheetRequest {
    pub rows: Vec<ImportRow>,
    /// Apply only: the `plan_digest` of the preview being applied.
    #[serde(default)]
    pub plan_digest: Option<String>,
}

/// One row of the report. No field values: row, outcome, code, ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportRowResult {
    pub row: u32,
    /// CREATE | UPDATE | VOID | UNCHANGED | ERROR
    pub outcome: String,
    pub employee_id: Option<Uuid>,
    pub entry_id: Option<Uuid>,
    pub code: Option<String>,
    pub message: Option<String>,
}

impl ImportRowResult {
    pub(crate) fn of(row: u32, planned: &PlannedRow) -> Self {
        let (outcome, entry_id, code) = match &planned.decision {
            Decision::Create => ("CREATE", None, None),
            Decision::Update { entry_id, .. } => ("UPDATE", Some(*entry_id), None),
            Decision::Void { entry_id, .. } => ("VOID", Some(*entry_id), None),
            Decision::Unchanged { entry_id } => ("UNCHANGED", Some(*entry_id), None),
            Decision::Error { code } => ("ERROR", None, Some((*code).to_owned())),
        };
        Self {
            row,
            outcome: outcome.to_owned(),
            employee_id: planned.employee,
            entry_id,
            code,
            message: planned.message.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportReport {
    pub section: Section,
    pub plan_digest: String,
    pub applied: bool,
    pub rows: Vec<ImportRowResult>,
}

fn report(section: Section, rows: &[ImportRow], plan: &Plan, applied: bool) -> ImportReport {
    ImportReport {
        section,
        plan_digest: hex::encode(&plan.digest),
        applied,
        rows: rows
            .iter()
            .zip(&plan.rows)
            .map(|(r, p)| ImportRowResult::of(r.row, p))
            .collect(),
    }
}

/// The switch gates rows that record values; a voids-only sheet runs with the
/// section off, as a one-by-one void does, so collected data can be retired.
async fn require_enabled_for(
    tx: &mut Transaction<'_, Postgres>,
    section: Section,
    rows: &[ImportRow],
) -> Result<(), HrError> {
    if rows.iter().any(|r| r.void_reason.is_none()) {
        require_enabled(tx, section).await?;
    }
    Ok(())
}

fn check_size(rows: &[ImportRow]) -> Result<(), HrError> {
    if rows.is_empty() || rows.len() as i64 > MAX_LIMIT {
        return Err(HrError::validation(format!(
            "a sheet holds 1 to {MAX_LIMIT} rows"
        )));
    }
    Ok(())
}

/// Write one planned row; returns the entry and version written.
async fn write_row(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    actor: Uuid,
    batch: Uuid,
    section: Section,
    row: &ImportRow,
    planned: &PlannedRow,
) -> Result<Option<(Uuid, i64)>, HrError> {
    let (entry_id, version, kind) = match planned.decision {
        Decision::Create => {
            let person = planned
                .person
                .ok_or_else(|| HrError::internal("planned row has no person"))?;
            (
                store::insert_entry(tx, org, person, section, actor).await?,
                1,
                RevisionKind::Create,
            )
        }
        Decision::Update { entry_id, version } => (entry_id, version + 1, RevisionKind::Update),
        Decision::Void { entry_id, version } => (entry_id, version + 1, RevisionKind::Void),
        Decision::Unchanged { .. } | Decision::Error { .. } => return Ok(None),
    };
    let fields = match (&planned.fields, kind) {
        (Some(f), _) => f.clone(),
        (None, _) => {
            store::load_entry(tx, org, entry_id)
                .await?
                .ok_or_else(|| HrError::internal("voided entry was not read back"))?
                .head
                .fields
        }
    };
    let row_digest =
        digest(&serde_json::to_value(row).map_err(|e| HrError::internal(e.to_string()))?);
    let rev = NewRevision {
        entry_id,
        version,
        kind,
        command_id: Uuid::new_v4(),
        digest: &row_digest,
        reason: planned.reason.as_deref(),
        batch: Some(batch),
        actor,
        fields: &fields,
    };
    insert_revision(tx, org, rev).await?;
    Ok(Some((entry_id, version)))
}

impl HrService {
    /// What applying the sheet would do now. Writes nothing.
    pub async fn preview_record_import(
        &self,
        principal: Principal,
        section: Section,
        request: ImportSheetRequest,
    ) -> Result<ImportReport, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        check_size(&request.rows)?;
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                require_enabled_for(tx, section, &request.rows).await?;
                let org = *principal.org_id.as_uuid();
                let g = if section.restricted() {
                    Some(gate(tx, &principal, section, false).await?)
                } else {
                    None
                };
                let planned = plan(tx, org, section, &request.rows, g.as_ref()).await?;
                Ok(report(section, &request.rows, &planned, false))
            })
        })
        .await
    }

    /// Apply a previewed sheet. Returns the report and whether it was applied
    /// now (201) or replayed (200).
    pub async fn apply_record_import(
        &self,
        principal: Principal,
        section: Section,
        command: Uuid,
        request: ImportSheetRequest,
    ) -> Result<(ImportReport, bool), HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        check_size(&request.rows)?;
        let expected = request
            .plan_digest
            .as_deref()
            .and_then(|d| hex::decode(d).ok())
            .filter(|d| d.len() == 32)
            .ok_or_else(|| HrError::validation("plan_digest from the preview is required"))?;
        with_audits::<_, _, HrError>(&self.pool.clone(), principal.org_id, move |tx| {
            Box::pin(async move {
                let org = *principal.org_id.as_uuid();
                let stored = sqlx::query("SELECT plan_digest, report FROM person_record_import_batches WHERE org_id = $1 AND command_id = $2")
                    .bind(org)
                    .bind(command)
                    .fetch_optional(tx.as_mut())
                    .await?;
                if let Some(stored) = stored {
                    let digest: Vec<u8> = stored.try_get("plan_digest")?;
                    if digest != expected {
                        return Err(idempotency_key_reused());
                    }
                    let report: serde_json::Value = stored.try_get("report")?;
                    let report = serde_json::from_value(report).map_err(|e| HrError::internal(e.to_string()))?;
                    return Ok(((report, false), Vec::new()));
                }
                require_enabled_for(tx, section, &request.rows).await?;
                let g = if section.restricted() { Some(gate(tx, &principal, section, false).await?) } else { None };
                // Mint and lock every person the sheet writes, in a stable
                // order, then plan again against the locked state.
                let first = plan(tx, org, section, &request.rows, g.as_ref()).await?;
                for employee in first.writers() {
                    writable_person(tx, principal.org_id, principal.user_id, employee).await?;
                }
                let planned = plan(tx, org, section, &request.rows, g.as_ref()).await?;
                if planned.digest != expected {
                    return Err(HrError {
                        status: http::StatusCode::CONFLICT,
                        code: "record_import_plan_changed",
                        message: "the sheet or the records changed since the preview; preview again".to_owned(),
                        refusals: None,
                    });
                }
                let actor = *principal.user_id.as_uuid();
                let mut events = Vec::new();
                for (row, p) in request.rows.iter().zip(&planned.rows) {
                    if let (Some((entry_id, version)), Some(employee)) = (write_row(tx, org, actor, command, section, row, p).await?, p.employee) {
                        let detail = json!({ "section": section.as_str(), "entry_id": entry_id, "version": version, "batch": command });
                        events.push(audit(principal.org_id, principal.user_id, "employee.record.import", ("employee", employee), detail)?);
                    }
                }
                let report = report(section, &request.rows, &planned, true);
                let stored = serde_json::to_value(&report).map_err(|e| HrError::internal(e.to_string()))?;
                sqlx::query("INSERT INTO person_record_import_batches (org_id, command_id, section, plan_digest, report, actor_id) VALUES ($1, $2, $3, $4, $5, $6)")
                    .bind(org)
                    .bind(command)
                    .bind(section.as_str())
                    .bind(&planned.digest)
                    .bind(stored)
                    .bind(actor)
                    .execute(tx.as_mut())
                    .await?;
                events.push(audit(principal.org_id, principal.user_id, "employee.record.import_batch", ("person_record_import_batch", command), json!({ "section": section.as_str(), "rows": request.rows.len(), "written": events.len() }))?);
                Ok(((report, true), events))
            })
        })
        .await
    }
}
