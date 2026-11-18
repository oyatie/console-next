// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_platform_authz::{
    Feature,
    cedar_pbac::{
        actions::leave_read,
        visible::{EmployeeVisibility, load_facts},
    },
};
use uuid::Uuid;

pub(super) struct QueueVisibility {
    employees: EmployeeVisibility,
    legacy_all: bool,
    legacy_branches: Vec<Uuid>,
}

impl QueueVisibility {
    pub(super) fn push(&self, query: &mut QueryBuilder<Postgres>) {
        query.push("(");
        query.push_bind(self.legacy_all);
        query.push(" OR branch_id = ANY(");
        query.push_bind(self.legacy_branches.clone());
        query.push(
            ") OR subject_employee_id IN (SELECT e.id FROM person_employees_current e \
                    LEFT JOIN employment_resolved_assignments ea \
                    ON ea.org_id=e.org_id AND ea.employee_id=e.id WHERE ",
        );
        self.employees.push(query);
        query.push("))");
    }
}

pub(super) async fn load(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    reader: UserId,
) -> Result<QueueVisibility, PgLeaveError> {
    let facts = load_facts(tx, org, *reader.as_uuid()).await?;
    let action = Feature::EmployeeDirectoryRead.as_str();
    let employees = facts
        .visible_employees(action)
        .map_err(|e| KernelError::internal(e.to_string()))?;
    let roles: Vec<_> = facts.roles().iter().map(String::as_str).collect();
    let legacy_all = leave_read::decide(&reader.to_string(), &org.to_string(), &roles, false)
        .map_err(KernelError::internal)?;
    let mut legacy_branches = Vec::new();
    if leave_read::decide(&reader.to_string(), &org.to_string(), &roles, true)
        .map_err(KernelError::internal)?
    {
        legacy_branches = sqlx::query_scalar(
            "SELECT branch_id FROM user_branches WHERE org_id=$1 AND user_id=$2",
        )
        .bind(org.as_uuid())
        .bind(reader.as_uuid())
        .fetch_all(tx.as_mut())
        .await?;
    }
    if !legacy_all
        && legacy_branches.is_empty()
        && facts
            .permitted_nodes(action)
            .map_err(|e| KernelError::internal(e.to_string()))?
            .is_empty()
    {
        return Err(KernelError::forbidden("leave queue is not permitted").into());
    }
    Ok(QueueVisibility {
        employees,
        legacy_all,
        legacy_branches,
    })
}
