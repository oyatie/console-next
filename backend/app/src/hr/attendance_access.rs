// SPDX-License-Identifier: LicenseRef-Proprietary
//! Payroll-linked attendance uses live Cedar authority in the write transaction.
use console_hr_adapter_postgres::HrError;
use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_authz::{
    Feature,
    access::{NodeKind, NodeRef},
    cedar_pbac::visible::{EmployeePlacement, load_facts},
};
use sqlx::{Postgres, Row, Transaction, types::Json};
use uuid::Uuid;

pub(super) async fn require(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Option<Uuid>,
) -> Result<(), HrError> {
    let facts = load_facts(tx, org, *actor.as_uuid())
        .await
        .map_err(HrError::from_kernel)?;
    let resource = if let Some(employee) = employee {
        let placement: Option<Json<EmployeePlacement>> = sqlx::query_scalar(
            "SELECT jsonb_build_object('org_unit_id',e.org_unit_id,'workplace_id',ea.workplace_id,'legal_entity_id',ea.legal_entity_id) \
             FROM person_employees_current e LEFT JOIN employment_resolved_assignments ea ON ea.org_id=e.org_id AND ea.employee_id=e.id \
             WHERE e.org_id=$1 AND e.id=$2",
        )
        .bind(org.as_uuid())
        .bind(employee)
        .fetch_optional(tx.as_mut())
        .await?;
        placement.ok_or_else(refused)?.0.node(org, &facts)
    } else {
        // Imports can touch multiple employees and retain tenant-wide admission.
        NodeRef {
            kind: NodeKind::Tenant,
            id: *org.as_uuid(),
        }
    };
    if facts
        .authorize(Feature::AttendanceExceptionManage.as_str(), resource)
        .map_err(|e| HrError::internal(format!("attendance access unavailable: {e}")))?
    {
        Ok(())
    } else {
        Err(refused())
    }
}

fn refused() -> HrError {
    HrError::from_kernel(
        KernelError::forbidden("attendance write authority is required")
            .with_code("attendance.refuse.missing_grant"),
    )
}

pub(super) async fn linked_employee(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
) -> Result<super::LinkedEmployee, HrError> {
    let sql = r#"
        SELECT u.employee_id, e.name AS employee_name
        FROM users u
        LEFT JOIN person_employees_current e
          ON e.id = u.employee_id
         AND e.org_id = u.org_id
        WHERE u.id = $1
          AND u.org_id = $2
        FOR UPDATE OF u
        "#;
    let row = sqlx::query(sql)
        .bind(*actor.as_uuid())
        .bind(*org.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::forbidden("linked employee account required"))
        })?;

    let employee_id = row
        .try_get::<Option<Uuid>, _>("employee_id")?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::forbidden("linked employee account required"))
        })?;
    let display_name = row
        .try_get::<Option<String>, _>("employee_name")?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::forbidden("linked employee record required"))
        })?;

    require(tx, org, actor, Some(employee_id)).await?;
    Ok(super::LinkedEmployee {
        employee_id,
        display_name,
    })
}
