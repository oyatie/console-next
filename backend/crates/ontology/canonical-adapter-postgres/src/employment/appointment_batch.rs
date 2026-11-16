// SPDX-License-Identifier: LicenseRef-Proprietary
//! Registration appointments share reference checks, frozen-window locks and one write.
use super::derived::legacy_head_command;
use super::{
    EmploymentError, appointment::insert_appointments, checks::WriteChecks, write::write_in_tx,
};
use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_domain::CommandReceipt;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

/// Appoint unbound legacy heads with the single writer's commands and validation.
/// Callers own authorization and must roll back the transaction on any error.
pub async fn appoint_legacy_heads_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employees: &[Uuid],
) -> Result<Vec<CommandReceipt>, EmploymentError> {
    let rows = sqlx::query(
        "SELECT e.id,e.company,e.org_unit,e.org_unit_id,e.position,e.employment_status,e.hire_on, \
         EXISTS(SELECT 1 FROM employment_source_bindings b WHERE b.org_id=e.org_id AND b.employee_id=e.id) AS bound \
         FROM employees e WHERE e.org_id=$1 AND e.id=ANY($2) ORDER BY e.id",
    ).bind(org.as_uuid()).bind(employees).fetch_all(tx.as_mut()).await?;
    let mut commands = Vec::with_capacity(rows.len());
    for row in rows {
        let employee_id = row.try_get("id")?;
        if let Some(command) = legacy_head_command(org, actor, employee_id, &row)? {
            commands.push((employee_id, command));
        }
    }
    if commands.is_empty() {
        return Ok(Vec::new());
    }
    let replay: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM ont_action_command_receipts WHERE org_id=$1 AND command_id=ANY($2))",
    ).bind(org.as_uuid())
        .bind(commands.iter().map(|(_, c)|*c.command_id.as_uuid()).collect::<Vec<_>>())
        .fetch_one(tx.as_mut()).await?;
    // Exceptional stored receipts retain the single writer's digest and receipt validation.
    if replay {
        let mut receipts = Vec::with_capacity(commands.len());
        for (_, command) in &commands {
            receipts.push(write_in_tx(tx, command).await?);
        }
        return Ok(receipts);
    }
    let mut checks = WriteChecks::default();
    for (_, command) in &commands {
        checks.check(tx, command).await?;
    }
    let appointments: Vec<_> = commands
        .iter()
        .map(|(id, command)| (*id, command))
        .collect();
    insert_appointments(tx, &appointments).await
}
