//! Current, non-blocking worker notices, shared by registration and detail reads.

use console_hr_domain::profile::enums::{EmploymentType, PayUnit};
use console_hr_domain::text::parse_yyyy_mm_dd;
use sqlx::Postgres;
use uuid::Uuid;

use crate::HrError;
use crate::authz::{Tier, hr_may_person_in};
use crate::clock::today_kst;
use crate::directory::create_checks::same_name_same_hire_date_warning;
use crate::directory::create_facts::wage_warning;
use crate::directory::types::{EmployeeCreateWarning, EmployeeResponse};
use console_platform_authz::{Feature, Principal};

pub async fn same_name_in_unit(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    name: &str,
    unit: Option<Uuid>,
) -> Result<Vec<EmployeeCreateWarning>, HrError> {
    let Some(unit) = unit else {
        return Ok(Vec::new());
    };
    let employee_ids = sqlx::query_scalar(
        "SELECT id FROM employees WHERE org_id = $1 AND org_unit_id = $2 \
         AND name = $3 AND id <> $4 AND employment_status <> 'EXITED' ORDER BY id",
    )
    .bind(org)
    .bind(unit)
    .bind(name)
    .bind(employee)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(if employee_ids.is_empty() {
        Vec::new()
    } else {
        vec![EmployeeCreateWarning {
            code: "same_name_in_unit",
            employee_ids,
            floor_won: None,
        }]
    })
}

pub async fn current_warnings(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    employee: &EmployeeResponse,
) -> Result<Vec<EmployeeCreateWarning>, HrError> {
    let mut warnings =
        same_name_in_unit(tx, org, employee.id, &employee.name, employee.org_unit_id).await?;
    warnings.extend(
        same_name_same_hire_date_warning(
            tx,
            org,
            employee.id,
            &employee.name,
            employee.hire_date.as_deref(),
        )
        .await?,
    );
    let on = employee
        .hire_date
        .as_deref()
        .map(parse_yyyy_mm_dd)
        .transpose()?
        .unwrap_or_else(today_kst)
        .max(today_kst());
    let contracts = crate::contract::load_rows(tx, org, employee.id).await?;
    let contract = console_hr_domain::contract::in_force(&contracts, on);
    let pay: Option<(Option<String>, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT employment_type, base_pay_won, pay_unit FROM employee_employment_profiles \
         WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(org)
    .bind(employee.id)
    .fetch_optional(tx.as_mut())
    .await?;
    if let Some((Some(kind), wage, unit)) = pay {
        let wage = wage.or_else(|| contract.map(|c| c.terms.wage_won));
        let unit = unit
            .map(|u| PayUnit::parse(&u))
            .transpose()?
            .or_else(|| contract.map(|c| c.terms.pay_unit));
        if let (Some(wage), Some(unit)) = (wage, unit) {
            warnings.extend(wage_warning(
                EmploymentType::parse(&kind)?,
                wage,
                unit,
                contract.and_then(|c| c.terms.weekly_minutes),
                on,
            ));
        }
    }
    Ok(warnings)
}

pub(super) async fn visible_warnings(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    reader: &Principal,
    warnings: &mut Vec<EmployeeCreateWarning>,
) -> Result<(), HrError> {
    for warning in warnings.iter_mut() {
        let mut visible = Vec::new();
        for id in warning.employee_ids.drain(..) {
            if hr_may_person_in(tx, reader, Feature::EmployeeDirectoryRead, id, Tier::Branch)
                .await?
            {
                visible.push(id);
            }
        }
        warning.employee_ids = visible;
    }
    warnings.retain(|w| w.code == "pay_below_minimum_wage" || !w.employee_ids.is_empty());
    Ok(())
}
