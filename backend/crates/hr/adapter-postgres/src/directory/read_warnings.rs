//! Current, non-blocking worker notices, shared by registration and detail reads.

use std::collections::HashSet;

use console_hr_domain::profile::enums::{EmploymentType, PayUnit};
use console_hr_domain::text::parse_yyyy_mm_dd;
use sqlx::{Postgres, QueryBuilder};
use uuid::Uuid;

use crate::HrError;
use crate::authz::{Tier, hr_reach_in};
use crate::clock::today_kst;
use crate::directory::create_checks::same_name_same_hire_date_warning;
use crate::directory::create_facts::wage_warning;
use crate::directory::read_filters::{push_within, visibility};
use crate::directory::types::{EmployeeCreateWarning, EmployeeResponse, EmployeeWarningMatch};
use console_platform_authz::{Feature, Principal};

pub const MAX_WARNING_MATCHES: usize = 20;
const WARNING_FETCH_CAP: i64 = 200;

pub(crate) fn build_name_warning(
    code: &'static str,
    rows: Vec<(Uuid, String, Option<String>, i64)>,
) -> Option<EmployeeCreateWarning> {
    let total_count = rows.first().map(|r| r.3)?;
    let matches: Vec<EmployeeWarningMatch> = rows
        .into_iter()
        .map(|(id, name, employee_number, _)| EmployeeWarningMatch {
            id,
            name,
            employee_number,
        })
        .collect();
    let employee_ids = matches.iter().map(|m| m.id).collect();
    Some(EmployeeCreateWarning {
        code,
        employee_ids,
        matches,
        total_count: Some(total_count),
        floor_won: None,
    })
}

pub(crate) fn cap_warnings(warnings: &mut [EmployeeCreateWarning]) {
    for warning in warnings.iter_mut() {
        if warning.code == "pay_below_minimum_wage" {
            continue;
        }
        if warning.total_count.is_none() {
            warning.total_count =
                Some(i64::try_from(warning.employee_ids.len()).unwrap_or(i64::MAX));
        }
        warning.employee_ids.truncate(MAX_WARNING_MATCHES);
        warning.matches.truncate(MAX_WARNING_MATCHES);
    }
}

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
    let rows: Vec<(Uuid, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT id, COALESCE(console_employee_facts(org_id, id)->>'legal_name', name) AS name, \
                employee_number, COUNT(*) OVER() AS total_count \
         FROM person_employees_current WHERE org_id = $1 AND org_unit_id = $2 \
           AND name = $3 AND id <> $4 AND employment_status <> 'EXITED' \
         ORDER BY id LIMIT $5",
    )
    .bind(org)
    .bind(unit)
    .bind(name)
    .bind(employee)
    .bind(WARNING_FETCH_CAP)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(build_name_warning("same_name_in_unit", rows)
        .into_iter()
        .collect())
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
    let mut candidate_ids: Vec<Uuid> = warnings
        .iter()
        .filter(|w| w.code != "pay_below_minimum_wage")
        .flat_map(|w| w.employee_ids.iter().copied())
        .collect();
    candidate_ids.sort_unstable();
    candidate_ids.dedup();

    let visible: HashSet<Uuid> = if candidate_ids.is_empty() {
        HashSet::new()
    } else if let Ok(reach) = hr_reach_in(reader, Feature::EmployeeDirectoryRead, Tier::Branch) {
        let vis = visibility(tx, reader, Feature::EmployeeDirectoryRead).await?;
        let mut q = QueryBuilder::<Postgres>::new("SELECT e.id FROM person_employees_current e");
        q.push(crate::assignment_lateral!());
        q.push(" WHERE e.id = ANY(");
        q.push_bind(candidate_ids);
        q.push(") AND ");
        push_within(&mut q, &reach, &vis);
        q.build_query_scalar::<Uuid>()
            .fetch_all(tx.as_mut())
            .await?
            .into_iter()
            .collect()
    } else {
        HashSet::new()
    };

    for warning in warnings.iter_mut() {
        if warning.code == "pay_below_minimum_wage" {
            continue;
        }
        let fetched = warning.employee_ids.len();
        warning.employee_ids.retain(|id| visible.contains(id));
        warning.matches.retain(|m| visible.contains(&m.id));
        let kept = warning.employee_ids.len();
        if kept < fetched {
            warning.total_count = Some(i64::try_from(kept).unwrap_or(i64::MAX));
        } else if warning.total_count.is_none() {
            warning.total_count = Some(i64::try_from(kept).unwrap_or(i64::MAX));
        }
    }
    cap_warnings(warnings);
    warnings.retain(|w| w.code == "pay_below_minimum_wage" || !w.employee_ids.is_empty());
    Ok(())
}
