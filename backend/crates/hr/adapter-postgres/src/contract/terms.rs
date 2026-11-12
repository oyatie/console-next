// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::HrError;
use console_hr_application::contract::ContractRowsPort;
use console_hr_domain::contract::{ContractRow, ContractTerms};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub struct ContractRows;

impl ContractRowsPort<Transaction<'_, Postgres>> for ContractRows {
    type Error = HrError;
    async fn load_rows(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: Uuid,
        employee: Uuid,
    ) -> Result<Vec<ContractRow>, HrError> {
        super::load_rows(tx, org, employee).await
    }
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
         end_date, wage_won, pay_unit, weekly_minutes, supersedes_id, created_by, \
         daily_minutes, scheduled_days_per_week, weekly_paid_minutes, terms_effective_from) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id",
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
    .bind(terms.daily_minutes)
    .bind(terms.scheduled_days_per_week)
    .bind(terms.weekly_paid_minutes)
    .bind(terms.terms_effective_from)
    .fetch_one(tx.as_mut())
    .await?)
}
