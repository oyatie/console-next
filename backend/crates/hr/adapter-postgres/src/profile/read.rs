//! The EMP-MODEL facts view: one record per employee, the shape both the GET
//! and the field PATCH (ME-6) work on. Dates are `YYYY-MM-DD` strings and
//! timestamps RFC 3339, so a GET → unchanged PATCH round trip never fails a
//! `test` (ME-9).

use console_hr_domain::profile::enums::{EmploymentType, IdType, PayUnit, WorkerClassification};
use console_hr_domain::profile::facts::{ProbationState, probation_state};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Row};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::authz::{authorize_hr_person, hr_reach};
use crate::clock::today_kst;
use crate::metrics::record_hr_read;
use crate::{HrError, HrService};

/// no 수습 종료 reminder window until the settings key exists
/// (`hr.probation.reminder_lead_days` in the settings-domain `keys.rs` roster,
/// F-SET, read through ADR-006's platform read path). Until then DUE_SOON is
/// never served; OVERDUE and days_left are.
const PROBATION_LEAD_DAYS: Option<u16> = None;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmploymentFacts {
    pub employee_id: Uuid,
    /// Read only here; the hire date has its own writers.
    pub hire_date: Option<String>,
    pub birth_date: Option<String>,
    pub work_email: Option<String>,
    pub id_type: Option<IdType>,
    /// Null for a roster-import row without an employment profile.
    #[serde(serialize_with = "serialize_classified_profile")]
    pub employment: Option<EmploymentProfileFacts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_employment: Option<EmploymentProfileFacts>,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EmploymentProfileFacts {
    pub employment_type: Option<EmploymentType>,
    /// Derived from `employment_type`; read only.
    pub worker_classification: Option<WorkerClassification>,
    pub base_pay_won: Option<i64>,
    pub pay_unit: Option<PayUnit>,
    pub probation_end_date: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub probation_confirmed_at: Option<OffsetDateTime>,
    /// Server clock (F5); read only.
    pub probation_state: ProbationState,
    pub probation_days_left: Option<i64>,
}

impl EmploymentFacts {
    pub(crate) fn hire(&self) -> Option<Date> {
        self.hire_date
            .as_deref()
            .and_then(|raw| parse_yyyy_mm_dd(raw).ok())
    }
}

pub(crate) fn date_text(date: Option<Date>) -> Option<String> {
    date.map(|date| date.to_string())
}

/// Load the view; `for_update` locks the employee row (and its profile) for
/// the write that follows (ME-13).
pub(crate) async fn load_facts(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
    for_update: bool,
) -> Result<EmploymentFacts, HrError> {
    macro_rules! facts_sql {
        ($tail:literal) => {
            concat!(
                "SELECT e.id, to_char(e.hire_on, 'YYYY-MM-DD') AS hire_date, CASE WHEN console_employee_facts(e.org_id,e.id) ? 'birth_date' THEN (console_employee_facts(e.org_id,e.id)->>'birth_date')::DATE ELSE e.birth_date END AS birth_date, e.work_email, e.id_type, e.updated_at, \
                 p.employee_id AS profile_employee_id, p.employment_type, p.base_pay_won, \
                 p.pay_unit, p.probation_end_date, p.probation_confirmed_at \
                 FROM employees e LEFT JOIN employee_employment_profiles p \
                 ON p.employee_id = e.id AND p.org_id = e.org_id \
                 WHERE e.org_id = $1 AND e.id = $2",
                $tail
            )
        };
    }
    let sql = if for_update {
        facts_sql!(" FOR UPDATE OF e")
    } else {
        facts_sql!("")
    };
    let row = sqlx::query(sql)
        .bind(org_id)
        .bind(employee_id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::not_found(
                "employee was not found in this organization",
            ))
        })?;
    if for_update {
        sqlx::query("SELECT 1 FROM employee_employment_profiles WHERE org_id = $1 AND employee_id = $2 FOR UPDATE")
            .bind(org_id)
            .bind(employee_id)
            .execute(tx.as_mut())
            .await?;
    }
    let employment = match row.try_get::<Option<Uuid>, _>("profile_employee_id")? {
        None => None,
        Some(_) => {
            let employment_type: Option<String> = row.try_get("employment_type")?;
            let employment_type = employment_type
                .as_deref()
                .map(EmploymentType::parse)
                .transpose()?;
            let end: Option<Date> = row.try_get("probation_end_date")?;
            let confirmed_at: Option<OffsetDateTime> = row.try_get("probation_confirmed_at")?;
            let (state, days_left) = probation_state(
                end,
                confirmed_at.is_some(),
                today_kst(),
                PROBATION_LEAD_DAYS,
            );
            let pay_unit: Option<String> = row.try_get("pay_unit")?;
            Some(EmploymentProfileFacts {
                employment_type,
                worker_classification: employment_type.map(EmploymentType::worker_classification),
                base_pay_won: row.try_get("base_pay_won")?,
                pay_unit: pay_unit.as_deref().map(PayUnit::parse).transpose()?,
                probation_end_date: date_text(end),
                probation_confirmed_at: confirmed_at,
                probation_state: state,
                probation_days_left: days_left,
            })
        }
    };
    let id_type: Option<String> = row.try_get("id_type")?;
    Ok(EmploymentFacts {
        employee_id,
        hire_date: row.try_get("hire_date")?,
        birth_date: date_text(row.try_get("birth_date")?),
        work_email: row.try_get("work_email")?,
        id_type: id_type.as_deref().map(IdType::parse).transpose()?,
        pending_employment: employment
            .as_ref()
            .filter(|profile| profile.employment_type.is_none())
            .cloned(),
        employment,
        updated_at: row.try_get("updated_at")?,
    })
}

fn serialize_classified_profile<S: serde::Serializer>(
    value: &Option<EmploymentProfileFacts>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    value
        .as_ref()
        .filter(|profile| profile.employment_type.is_some())
        .serialize(serializer)
}

impl HrService {
    /// GET the facts. Birth date, ID type and pay are personal data: only the
    /// org-wide directory manager reads them (the same tier that sees pay in
    /// the employee detail).
    pub async fn employment_facts(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<EmploymentFacts, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        record_hr_read("employment_facts");
        let org_uuid = *principal.org_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                authorize_hr_person(
                    tx,
                    &principal,
                    Feature::EmployeeDirectoryManage,
                    employee_id,
                )
                .await?;
                load_facts(tx, org_uuid, employee_id, false).await
            })
        })
        .await
    }
}
