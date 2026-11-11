//! Loads (and locks) the employee head a lifecycle event meets.

use console_hr_domain::lifecycle::classification::Classification;
use console_hr_domain::lifecycle::event::EmployeeForLifecycle;
use console_kernel_core::KernelError;
use sqlx::{Postgres, Row};
use uuid::Uuid;

use super::guards::RecordGuardFacts;
use crate::HrError;
use std::collections::BTreeMap;

pub async fn load_employee_for_lifecycle(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_id: Uuid,
) -> Result<EmployeeForLifecycle, HrError> {
    let row = sqlx::query(
        r#"
        SELECT e.company, e.org_unit, e.org_unit_id, e.position, e.job_title_id, e.employment_status,
               e.grade_id, e.position_kind_id, e.job_id, e.job_family_id, e.job,
               p.employment_type, p.contract_start_date, p.contract_end_date
        FROM employees e
        LEFT JOIN employee_employment_profiles p
          ON p.employee_id = e.id AND p.org_id = e.org_id
        WHERE e.org_id = $1 AND e.id = $2
        FOR UPDATE OF e
        "#,
    )
    .bind(org_uuid)
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| HrError::from_kernel(KernelError::not_found("employee not found")))?;

    current_from_row(&row)
}

fn current_from_row(row: &sqlx::postgres::PgRow) -> Result<EmployeeForLifecycle, HrError> {
    Ok(EmployeeForLifecycle {
        company: row.try_get("company")?,
        org_unit: row.try_get("org_unit")?,
        org_unit_id: row.try_get("org_unit_id")?,
        position: row.try_get("position")?,
        job_title_id: row.try_get("job_title_id")?,
        employment_status: row.try_get("employment_status")?,
        employment_type: row.try_get("employment_type")?,
        contract_start_date: row.try_get("contract_start_date")?,
        contract_end_date: row.try_get("contract_end_date")?,
        classification: Classification {
            grade_id: row.try_get("grade_id")?,
            position_kind_id: row.try_get("position_kind_id")?,
            job_id: row.try_get("job_id")?,
            job_family_id: row.try_get("job_family_id")?,
            job: row.try_get("job")?,
        },
    })
}

pub(crate) struct LifecycleHead {
    pub current: EmployeeForLifecycle,
    pub guards: RecordGuardFacts,
}

pub(crate) async fn load_employee_heads(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    employees: &[Uuid],
) -> Result<BTreeMap<Uuid, LifecycleHead>, HrError> {
    let rows = sqlx::query("SELECT e.id,e.company,e.org_unit,e.org_unit_id,e.position,e.job_title_id,e.employment_status, \
        e.grade_id,e.position_kind_id,e.job_id,e.job_family_id,e.job,e.hire_date,e.head_version, \
        p.employment_type,p.contract_start_date,p.contract_end_date,p.contract_end_date::text AS guard_contract_end \
        FROM employees e LEFT JOIN employee_employment_profiles p ON p.employee_id=e.id AND p.org_id=e.org_id \
        WHERE e.org_id=$1 AND e.id=ANY($2) ORDER BY e.id FOR UPDATE OF e")
        .bind(org).bind(employees).fetch_all(tx.as_mut()).await?;
    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get("id")?,
                LifecycleHead {
                    current: current_from_row(&row)?,
                    guards: RecordGuardFacts {
                        hire: row.try_get("hire_date")?,
                        version: row.try_get("head_version")?,
                        contract_end: row.try_get("guard_contract_end")?,
                    },
                },
            ))
        })
        .collect()
}
