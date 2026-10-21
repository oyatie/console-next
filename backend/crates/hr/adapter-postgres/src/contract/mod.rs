//! G1 contract history: list and record (append-only; a correction is a row
//! that supersedes the wrong one). Recording is idempotent on the request's
//! Idempotency-Key, stored as `command_id` (ontology INTEG-1): a replay
//! returns the stored row, a reused key with other terms is a 409.

use console_hr_domain::contract::{
    ContractKind, ContractRow, ContractTerms, in_force, overlapping, validate_terms,
};
use console_hr_domain::profile::enums::PayUnit;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, Row};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::authz::{authorize_hr_person, hr_reach};
use crate::clock::today_kst;
use crate::metrics::record_hr_read;
use crate::own_record::own_record_guard;
use crate::profile::date_text;
use crate::{HrError, HrService};
mod refusal;

const MANAGE: Feature = Feature::EmployeeDirectoryManage;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RecordContractRequest {
    pub kind: ContractKind,
    pub start_date: String,
    pub end_date: Option<String>,
    pub wage_won: i64,
    pub pay_unit: PayUnit,
    pub weekly_minutes: Option<i32>,
    /// The row this one corrects; omitted for a new contract or a renewal.
    pub supersedes_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContractView {
    pub id: Uuid,
    pub kind: ContractKind,
    pub start_date: String,
    pub end_date: Option<String>,
    pub wage_won: i64,
    pub pay_unit: PayUnit,
    pub weekly_minutes: Option<i32>,
    pub supersedes_id: Option<Uuid>,
    /// Set when a later row corrected this one; it then leaves the history.
    pub superseded_by: Option<Uuid>,
    /// Covers today (KST) and is not superseded.
    pub in_force: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContractList {
    pub items: Vec<ContractView>,
}

struct Stored {
    row: ContractRow,
    command_id: Uuid,
    created_at: OffsetDateTime,
}

pub(crate) async fn load_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
) -> Result<Vec<ContractRow>, HrError> {
    Ok(load_stored(tx, org_id, employee_id)
        .await?
        .into_iter()
        .map(|s| s.row)
        .collect())
}

async fn load_stored(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
) -> Result<Vec<Stored>, HrError> {
    let rows = sqlx::query(
        "SELECT id, command_id, kind, start_date, end_date, wage_won, pay_unit, weekly_minutes, \
         supersedes_id, created_at FROM employee_contracts WHERE org_id = $1 AND employee_id = $2 \
         ORDER BY start_date DESC, created_at DESC",
    )
    .bind(org_id)
    .bind(employee_id)
    .fetch_all(tx.as_mut())
    .await?;
    rows.into_iter()
        .map(|row| {
            let kind: String = row.try_get("kind")?;
            let pay_unit: String = row.try_get("pay_unit")?;
            Ok(Stored {
                command_id: row.try_get("command_id")?,
                created_at: row.try_get("created_at")?,
                row: ContractRow {
                    id: row.try_get("id")?,
                    supersedes_id: row.try_get("supersedes_id")?,
                    terms: ContractTerms {
                        kind: ContractKind::parse(&kind)?,
                        start_date: row.try_get("start_date")?,
                        end_date: row.try_get("end_date")?,
                        wage_won: row.try_get("wage_won")?,
                        pay_unit: PayUnit::parse(&pay_unit)?,
                        weekly_minutes: row.try_get("weekly_minutes")?,
                    },
                },
            })
        })
        .collect()
}

fn view(all: &[Stored], stored: &Stored, today: Date) -> ContractView {
    let rows: Vec<ContractRow> = all.iter().map(|s| s.row.clone()).collect();
    let row = &stored.row;
    ContractView {
        id: row.id,
        kind: row.terms.kind,
        start_date: row.terms.start_date.to_string(),
        end_date: date_text(row.terms.end_date),
        wage_won: row.terms.wage_won,
        pay_unit: row.terms.pay_unit,
        weekly_minutes: row.terms.weekly_minutes,
        supersedes_id: row.supersedes_id,
        superseded_by: rows
            .iter()
            .find(|r| r.supersedes_id == Some(row.id))
            .map(|r| r.id),
        in_force: in_force(&rows, today).is_some_and(|live| live.id == row.id),
        created_at: stored.created_at,
    }
}

async fn require_employee(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    lock: bool,
) -> Result<(), HrError> {
    // A record locks the head: concurrent records for one person serialize
    // here, so the overlap check sees every committed row (ME-13).
    let sql = if lock {
        "SELECT 1 FROM employees WHERE org_id = $1 AND id = $2 FOR UPDATE"
    } else {
        "SELECT 1 FROM employees WHERE org_id = $1 AND id = $2"
    };
    sqlx::query(sql)
        .bind(org_id)
        .bind(employee_id)
        .fetch_optional(tx.as_mut())
        .await?
        .map(|_| ())
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::not_found(
                "employee was not found in this organization",
            ))
        })
}

/// Appends one validated row in the caller's transaction; the registration
/// (EMP-CREATE) records the first contract through it.
pub(crate) async fn insert_row(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    command_id: Uuid,
    terms: &ContractTerms,
    supersedes_id: Option<Uuid>,
    actor: Uuid,
) -> Result<Uuid, HrError> {
    Ok(sqlx::query_scalar(
        "INSERT INTO employee_contracts (org_id, employee_id, command_id, kind, start_date, \
         end_date, wage_won, pay_unit, weekly_minutes, supersedes_id, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id",
    )
    .bind(org_id)
    .bind(employee_id)
    .bind(command_id)
    .bind(terms.kind.as_str())
    .bind(terms.start_date)
    .bind(terms.end_date)
    .bind(terms.wage_won)
    .bind(terms.pay_unit.as_str())
    .bind(terms.weekly_minutes)
    .bind(supersedes_id)
    .bind(actor)
    .fetch_one(tx.as_mut())
    .await?)
}

fn terms_of(request: &RecordContractRequest) -> Result<ContractTerms, HrError> {
    let terms = ContractTerms {
        kind: request.kind,
        start_date: parse_yyyy_mm_dd(&request.start_date)?,
        end_date: request
            .end_date
            .as_deref()
            .map(parse_yyyy_mm_dd)
            .transpose()?,
        wage_won: request.wage_won,
        pay_unit: request.pay_unit,
        weekly_minutes: request.weekly_minutes,
    };
    validate_terms(&terms)?;
    Ok(terms)
}

impl HrService {
    pub async fn employee_contracts(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<ContractList, HrError> {
        // Wages are compensation: the manager tier, as in the employee detail.
        hr_reach(&principal, MANAGE)?;
        record_hr_read("employee_contracts");
        let org_uuid = *principal.org_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, MANAGE, employee_id).await?;
                require_employee(tx, org_uuid, employee_id, false).await?;
                let all = load_stored(tx, org_uuid, employee_id).await?;
                let today = today_kst();
                Ok(ContractList {
                    items: all.iter().map(|s| view(&all, s, today)).collect(),
                })
            })
        })
        .await
    }

    /// Returns the row and whether it was created now (201) or replayed (200).
    pub async fn record_contract(
        &self,
        principal: Principal,
        employee_id: Uuid,
        command_id: Uuid,
        request: RecordContractRequest,
    ) -> Result<(ContractView, bool), HrError> {
        hr_reach(&principal, MANAGE)?;
        let terms = terms_of(&request)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let actor = principal.user_id;
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, MANAGE, employee_id).await?;
                require_employee(tx, org_uuid, employee_id, true).await?;
                let manage = Feature::EmployeeDirectoryManage;
                own_record_guard(tx, org, actor, employee_id, manage).await?;
                let all = load_stored(tx, org_uuid, employee_id).await?;
                let today = today_kst();
                if let Some(prior) = all.iter().find(|s| s.command_id == command_id) {
                    if prior.row.terms == terms && prior.row.supersedes_id == request.supersedes_id
                    {
                        return Ok(((view(&all, prior, today), false), Vec::new()));
                    }
                    return Err(HrError::from_kernel(KernelError::conflict(
                        "this Idempotency-Key was already used for a different contract",
                    )));
                }
                let rows: Vec<ContractRow> = all.iter().map(|s| s.row.clone()).collect();
                if let Some(target) = request.supersedes_id {
                    let row = rows.iter().find(|r| r.id == target).ok_or_else(|| {
                        HrError::from_kernel(KernelError::not_found(
                            "the contract to correct was not found",
                        ))
                    })?;
                    if rows.iter().any(|r| r.supersedes_id == Some(row.id)) {
                        return Err(HrError::from_kernel(KernelError::conflict(
                            "that contract was already corrected; correct the newer row",
                        )));
                    }
                }
                if let Some(other) = overlapping(&rows, &terms, request.supersedes_id) {
                    return Err(refusal::overlap(other));
                }
                let id = insert_row(
                    tx,
                    org_uuid,
                    employee_id,
                    command_id,
                    &terms,
                    request.supersedes_id,
                    *actor.as_uuid(),
                )
                .await?;
                let all = load_stored(tx, org_uuid, employee_id).await?;
                let created = all
                    .iter()
                    .find(|s| s.row.id == id)
                    .map(|s| view(&all, s, today))
                    .ok_or_else(|| HrError::internal("recorded contract was not read back"))?;
                // No wage in the audit row: compensation stays in its table.
                let audit = AuditEvent::new(
                    Some(actor),
                    AuditAction::new("employee.contract.record").map_err(HrError::from_kernel)?,
                    "employee",
                    employee_id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "contract_id": id,
                        "kind": terms.kind.as_str(),
                        "start_date": &created.start_date,
                        "end_date": &created.end_date,
                        "supersedes_id": request.supersedes_id,
                    })),
                );
                Ok(((created, true), vec![audit]))
            })
        })
        .await
    }
}
