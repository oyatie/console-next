//! The employee record a 정정 works on, locked for the transaction, with the
//! current value of every correctable field as stored text.

use console_kernel_core::KernelError;
use http::StatusCode;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::profile::{self, ProfileValues};
use super::refusal;
use crate::HrError;
use crate::personal_facts::{self, store::PersonalRow};
use crate::register_facts::{self, store::RegisterRow};

/// The employee's correctable head, locked for this transaction.
pub(crate) struct LockedEmployee {
    pub name: String,
    pub catalog: [Option<String>; 5],
    pub hire_date: Option<String>,
    pub exit_date: Option<String>,
    pub employee_number: Option<String>,
    pub job: Option<String>,
    pub birth_date: Option<String>,
    pub work_email: Option<String>,
    pub id_type: Option<String>,
    pub employment_status: String,
    pub updated_at: OffsetDateTime,
    pub identity_review_required: bool,
    pub profile: Option<ProfileValues>,
    /// The 근로자 명부 items (MR-23).
    pub register: RegisterRow,
    /// The 인적사항 extras (MR-34).
    pub personal: PersonalRow,
}

impl LockedEmployee {
    /// The stored value of `field`, `None` when nothing is recorded (or the
    /// record has no employment profile for a profile field).
    pub(crate) fn current(&self, field: &str) -> Option<&str> {
        match field {
            "grade_id" => self.catalog[0].as_deref(),
            "job_title_id" => self.catalog[1].as_deref(),
            "position_kind_id" => self.catalog[2].as_deref(),
            "job_id" => self.catalog[3].as_deref(),
            "job_family_id" => self.catalog[4].as_deref(),
            "name" => Some(self.name.as_str()),
            "hire_date" => self.hire_date.as_deref(),
            "exit_date" => self.exit_date.as_deref(),
            "employee_number" => self.employee_number.as_deref(),
            "job" => self.job.as_deref(),
            "birth_date" => self.birth_date.as_deref(),
            "work_email" => self.work_email.as_deref(),
            "id_type" => self.id_type.as_deref(),
            item if register_facts::is_register_field(item) => self.register.stored(item),
            item if personal_facts::is_personal_field(item) => self.personal.stored(item),
            other => self.profile.as_ref().and_then(|profile| profile.get(other)),
        }
    }
}

/// Locks the employee row; a missing row is 404 and a merged record (it
/// points at the record that was kept) is 409.
pub(crate) async fn lock_employee(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
) -> Result<LockedEmployee, HrError> {
    load_employee(tx, org, employee_id, true).await
}

/// [`lock_employee`] without the row lock: a bulk preview reads thousands of
/// records and must not hold them (MR-27).
pub(crate) async fn read_employee(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
) -> Result<LockedEmployee, HrError> {
    load_employee(tx, org, employee_id, false).await
}

async fn load_employee(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    employee_id: Uuid,
    lock: bool,
) -> Result<LockedEmployee, HrError> {
    macro_rules! select {
        () => {
            "SELECT e.name, e.hire_date, e.exit_date, e.employee_number, e.job, \
         to_char(e.birth_date, 'YYYY-MM-DD') AS birth_date, e.work_email, e.id_type, \
         e.grade_id::text, e.job_title_id::text, e.position_kind_id::text, e.job_id::text, e.job_family_id::text, \
         e.employment_status, e.updated_at, e.identity_review_required, \
         p.employee_id IS NOT NULL AS has_profile, p.phone_e164, p.employment_type, \
         p.base_pay::text AS base_pay, p.pay_unit, \
         to_char(p.probation_end_date, 'YYYY-MM-DD') AS probation_end_date, \
         p.probation_confirmed_at IS NOT NULL AS probation_confirmed FROM employees e \
         LEFT JOIN employee_employment_profiles p ON p.org_id = e.org_id AND p.employee_id = e.id \
         WHERE e.org_id = $1 AND e.id = $2"
        };
    }
    let sql = if lock {
        concat!(select!(), " FOR UPDATE OF e")
    } else {
        select!()
    };
    let row = sqlx::query(sql)
        .bind(org)
        .bind(employee_id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::not_found(
                "employee was not found in this organization",
            ))
        })?;
    let merged: Option<Uuid> = sqlx::query_scalar(
        "SELECT merged_into_employee_id FROM employee_identity_resolutions \
         WHERE org_id = $1 AND employee_id = $2 AND merged_into_employee_id IS NOT NULL",
    )
    .bind(org)
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?;
    if let Some(kept) = merged {
        return Err(refusal(
            StatusCode::CONFLICT,
            "employee_merged",
            format!("this record was merged into employee {kept}; correct that record"),
        ));
    }
    Ok(LockedEmployee {
        catalog: [
            row.try_get("grade_id")?,
            row.try_get("job_title_id")?,
            row.try_get("position_kind_id")?,
            row.try_get("job_id")?,
            row.try_get("job_family_id")?,
        ],
        name: row.try_get("name")?,
        hire_date: row.try_get("hire_date")?,
        exit_date: row.try_get("exit_date")?,
        employee_number: row.try_get("employee_number")?,
        job: row.try_get("job")?,
        birth_date: row.try_get("birth_date")?,
        work_email: row.try_get("work_email")?,
        id_type: row.try_get("id_type")?,
        employment_status: row.try_get("employment_status")?,
        updated_at: row.try_get("updated_at")?,
        identity_review_required: row.try_get("identity_review_required")?,
        profile: profile::profile_from_row(&row)?,
        register: register_facts::store::load_in_tx(tx, org, employee_id).await?,
        personal: personal_facts::store::load_in_tx(tx, org, employee_id).await?,
    })
}
