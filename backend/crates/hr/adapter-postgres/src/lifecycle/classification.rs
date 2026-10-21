//! MR-24 / MR-25 lifecycle seams: the catalog ids a PROMOTE (직급) or APPOINT
//! (직책, 직무, 직군) names, the 강등 check on the 직급, the head they leave,
//! the 고용형태 전환 written to the employment profile, and the restore of
//! all of them by a rescission. Pure rules: hr-domain `classification`.

use console_hr_domain::lifecycle::classification::{
    ClassificationColumns, EmploymentWindow, keeps_status,
};
use console_hr_domain::lifecycle::event::{
    EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition,
};
use console_hr_domain::lifecycle::fixed_term::DatePeriod;
use console_hr_domain::lifecycle::job_title::check_demotion_reason;
use console_hr_domain::text::normalize_enum_text;
use console_kernel_core::KernelError;
use console_ontology_canonical_adapter_postgres::employment_job_title::{
    set_employee_classification, set_employee_job_title,
};
use sqlx::{Postgres, Row};
use time::Date;
use uuid::Uuid;

use super::prepare::LifecycleTarget;
use super::title_reason::coded;
use crate::HrError;

/// An event that keeps the status meets the head's (a renewal, an APPOINT, a
/// 전환 never change it).
pub fn resolve_kept_status(
    transition: &mut NormalizedEmployeeLifecycleTransition,
    head: &EmployeeForLifecycle,
) {
    if keeps_status(&transition.event_type) {
        transition.to_status = normalize_enum_text(head.employment_status.clone());
    }
}

/// Checks each catalog id the event names (active, of its kind) and fills the
/// 직무 label into `to_job`.
///
/// # Errors
/// 422 `job_title_unknown` naming the field.
pub async fn fill_classification(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    transition: &mut NormalizedEmployeeLifecycleTransition,
) -> Result<(), HrError> {
    let change = &transition.classify;
    let named = [
        (change.to_grade_id, "GRADE", "to_grade_id"),
        (
            change.to_position_kind_id,
            "POSITION",
            "to_position_kind_id",
        ),
        (change.to_job_id, "JOB", "to_job_id"),
        (change.to_job_family_id, "JOB_FAMILY", "to_job_family_id"),
    ];
    for (id, kind, field) in named {
        let Some(id) = id else { continue };
        let label: Option<String> = sqlx::query_scalar(
            "SELECT label FROM job_titles WHERE org_id = $1 AND id = $2 AND kind = $3 AND active",
        )
        .bind(org)
        .bind(id)
        .bind(kind)
        .fetch_optional(tx.as_mut())
        .await?;
        let label = label.ok_or_else(|| {
            coded(
                KernelError::validation(format!("{field} is not an active {kind} entry"))
                    .with_code("job_title_unknown")
                    .with_field(field),
            )
        })?;
        if kind == "JOB" {
            transition.classify.to_job = Some(label);
        }
    }
    Ok(())
}

async fn ranks(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    from: Uuid,
    to: Uuid,
) -> Result<(Option<i32>, Option<i32>), HrError> {
    Ok(sqlx::query_as(
        "SELECT (SELECT grade_rank FROM job_titles WHERE org_id = $1 AND id = $2), \
                (SELECT grade_rank FROM job_titles WHERE org_id = $1 AND id = $3)",
    )
    .bind(org)
    .bind(from)
    .bind(to)
    .fetch_one(tx.as_mut())
    .await?)
}

/// The 강등 check of a PROMOTE on one ranked pair (직급 or 직위).
///
/// # Errors
/// 422 `demotion_reason_required`.
pub async fn check_demotion(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    pair: (Option<Uuid>, Option<Uuid>),
    reason_code: Option<&str>,
) -> Result<(), HrError> {
    let (Some(from), Some(to)) = pair else {
        return Ok(());
    };
    let (from_rank, to_rank) = ranks(tx, org, from, to).await?;
    check_demotion_reason(from_rank, to_rank, reason_code).map_err(coded)
}

/// 409 `employment_profile_missing`: a 전환 needs the employment profile
/// (an imported person has none until IMPORT creates it, MR-7).
pub fn profile_missing() -> HrError {
    coded(
        KernelError::conflict(
            "this employee has no employment profile; record the employment type first",
        )
        .with_code("employment_profile_missing"),
    )
}

async fn write_window(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    window: &EmploymentWindow,
) -> Result<(), HrError> {
    let written = sqlx::query(
        "UPDATE employee_employment_profiles SET employment_type = $3, \
         contract_start_date = $4, contract_end_date = $5 \
         WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(org)
    .bind(employee)
    .bind(&window.employment_type)
    .bind(window.contract_start_date)
    .bind(window.contract_end_date)
    .execute(tx.as_mut())
    .await?
    .rows_affected();
    if written == 0 {
        return Err(profile_missing());
    }
    Ok(())
}

async fn write_classification(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    head: &console_hr_domain::lifecycle::classification::Classification,
) -> Result<(), HrError> {
    let ids = [
        head.grade_id,
        head.position_kind_id,
        head.job_id,
        head.job_family_id,
    ];
    set_employee_classification(tx, org, employee, ids, head.job.as_deref()).await?;
    Ok(())
}

/// Writes what a PROMOTE, APPOINT or 전환 leaves on the employee.
pub async fn apply_classification(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    event_type: &str,
    target: &LifecycleTarget,
) -> Result<(), HrError> {
    if matches!(event_type, "PROMOTE" | "APPOINT") {
        write_classification(tx, org, employee, &target.classification).await?;
    }
    if let Some(window) = &target.employment {
        write_window(tx, org, employee, window).await?;
    }
    Ok(())
}

/// The classification columns of an event row (`lifecycle_event_select!`
/// and [`load_before`] select them all).
pub fn columns_from_row(row: &sqlx::postgres::PgRow) -> Result<ClassificationColumns, HrError> {
    Ok(ClassificationColumns {
        from_grade_id: row.try_get("from_grade_id")?,
        to_grade_id: row.try_get("to_grade_id")?,
        from_position_kind_id: row.try_get("from_position_kind_id")?,
        to_position_kind_id: row.try_get("to_position_kind_id")?,
        from_job_id: row.try_get("from_job_id")?,
        to_job_id: row.try_get("to_job_id")?,
        from_job_family_id: row.try_get("from_job_family_id")?,
        to_job_family_id: row.try_get("to_job_family_id")?,
        from_job: row.try_get("from_job")?,
        to_job: row.try_get("to_job")?,
        from_employment_type: row.try_get("from_employment_type")?,
        to_employment_type: row.try_get("to_employment_type")?,
        from_contract_start_date: row.try_get("from_contract_start_date")?,
    })
}

/// The before/after columns of an event being voided, and its contract end
/// before.
pub async fn load_before(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    event: Uuid,
) -> Result<(ClassificationColumns, Option<Date>), HrError> {
    let row = sqlx::query(
        "SELECT from_grade_id, to_grade_id, from_position_kind_id, to_position_kind_id, \
                from_job_id, to_job_id, from_job_family_id, to_job_family_id, from_job, to_job, \
                from_employment_type, to_employment_type, from_contract_start_date, \
                from_contract_end_date \
         FROM employee_lifecycle_events WHERE org_id = $1 AND id = $2",
    )
    .bind(org)
    .bind(event)
    .fetch_one(tx.as_mut())
    .await?;
    Ok((
        columns_from_row(&row)?,
        row.try_get("from_contract_end_date")?,
    ))
}

/// The head with a voided PROMOTE (직급), APPOINT or 전환 undone, in memory.
pub fn restore_classification(
    head: &mut EmployeeForLifecycle,
    event_type: &str,
    (before, from_end): &(ClassificationColumns, Option<Date>),
) {
    match event_type {
        "PROMOTE" if before.to_grade_id.is_some() => {
            head.classification.grade_id = before.from_grade_id;
        }
        "APPOINT" => {
            let c = &mut head.classification;
            c.position_kind_id = before.from_position_kind_id;
            c.job_id = before.from_job_id;
            c.job_family_id = before.from_job_family_id;
            c.job.clone_from(&before.from_job);
        }
        "EMPLOYMENT_TYPE_CHANGE" => {
            head.employment_type
                .clone_from(&before.from_employment_type);
            head.contract_start_date = before.from_contract_start_date;
            head.contract_end_date = *from_end;
        }
        _ => {}
    }
}

/// Writes the restored head of a voided PROMOTE (직위 and 직급), APPOINT or 전환.
pub async fn write_restored(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
    event_type: &str,
    head: &EmployeeForLifecycle,
) -> Result<(), HrError> {
    match (event_type, &head.employment_type) {
        ("PROMOTE", _) => {
            set_employee_job_title(tx, org, employee, head.job_title_id).await?;
            write_classification(tx, org, employee, &head.classification).await
        }
        ("APPOINT", _) => write_classification(tx, org, employee, &head.classification).await,
        ("EMPLOYMENT_TYPE_CHANGE", Some(employment_type)) => {
            let window = EmploymentWindow {
                employment_type: employment_type.clone(),
                contract_start_date: head.contract_start_date,
                contract_end_date: head.contract_end_date,
            };
            write_window(tx, org, employee, &window).await
        }
        _ => Ok(()),
    }
}

/// The fixed-term windows that applied (not voided) 전환 away from CONTRACT
/// closed, each ending the day before its 전환 at the latest, oldest first.
pub async fn closed_contract_windows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    employee: Uuid,
) -> Result<Vec<DatePeriod>, HrError> {
    let rows: Vec<(Date, Date)> = sqlx::query_as(
        "SELECT w.start_date, w.end_date FROM ( \
           SELECT l.from_contract_start_date AS start_date, \
                  LEAST(COALESCE(l.from_contract_end_date, l.effective_date::DATE - 1), \
                        l.effective_date::DATE - 1) AS end_date, l.effective_date \
           FROM employee_lifecycle_events l \
           WHERE l.org_id = $1 AND l.employee_id = $2 AND l.state = 'APPLIED' \
             AND l.event_type = 'EMPLOYMENT_TYPE_CHANGE' AND l.from_employment_type = 'CONTRACT' \
             AND l.from_contract_start_date IS NOT NULL \
             AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v \
                             WHERE v.voids_event_id = l.id)) w \
         WHERE w.start_date <= w.end_date ORDER BY w.effective_date",
    )
    .bind(org)
    .bind(employee)
    .fetch_all(tx.as_mut())
    .await?;
    Ok(rows
        .into_iter()
        .map(|(start, end)| DatePeriod { start, end })
        .collect())
}
