//! BW-19 4: the registration's ONBOARD. A hire date on or before today (KST)
//! records it APPLIED, as before; a later one makes the employee 입사 예정
//! (PRE_HIRE) and stores the ONBOARD SCHEDULED, so the lifecycle runner
//! (`HrService::apply_due`) makes them ACTIVE on the hire date. Before this a
//! future hire date was refused, which left pre-boarding a dead end.

use console_hr_domain::lifecycle::event::NormalizedEmployeeLifecycleTransition;
use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_ontology_canonical_adapter_postgres::employee_intake;
use serde_json::json;
use sqlx::Postgres;
use time::Date;
use uuid::Uuid;

use crate::HrError;
use crate::directory::create::employee_create_db_error;

const ONBOARD_COMMENT: &str = "Created through People & Workforce";

/// The ONBOARD a registration records.
pub struct RegistrationOnboard<'a> {
    pub company: &'a str,
    pub org_unit: &'a str,
    pub org_unit_id: Option<Uuid>,
    pub position: &'a str,
    /// `YYYY-MM-DD`; `None` (recruiting hire) is today.
    pub hire_date: Option<&'a str>,
}

/// True when the hire date is after `today` (KST): the employee is PRE_HIRE.
///
/// # Errors
/// Validation when the date is not `YYYY-MM-DD`.
pub fn is_pre_hire(hire_date: Option<&str>, today: Date) -> Result<bool, HrError> {
    Ok(hire_date
        .map(parse_yyyy_mm_dd)
        .transpose()?
        .is_some_and(|date| date > today))
}

/// Marks the just-inserted head PRE_HIRE when the hire date is in the future.
pub async fn mark_pre_hire(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_id: Uuid,
) -> Result<(), HrError> {
    Ok(employee_intake::mark_pre_hire(tx, org_uuid, employee_id).await?)
}

/// Inserts the registration's ONBOARD: APPLIED, or SCHEDULED with the request
/// the runner re-validates on the hire date.
pub async fn record_registration_onboard(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: Uuid,
    employee_id: Uuid,
    onboard: &RegistrationOnboard<'_>,
    today: Date,
) -> Result<(), HrError> {
    let effective_date = onboard
        .hire_date
        .map_or_else(|| today.to_string(), str::to_owned);
    let scheduled = is_pre_hire(onboard.hire_date, today)?;
    let scheduled_request = if scheduled {
        // The runner re-validates every scheduled event with the base acks.
        // The registration is HR's own record of the hire, so it carries them;
        // the ledger row's `signoffs` stays `{}`, exactly as for an immediate
        // ONBOARD (until BW-05/BW-11 drop the server sign-offs).
        let transition = NormalizedEmployeeLifecycleTransition {
            event_type: "ONBOARD".to_owned(),
            to_status: "ACTIVE".to_owned(),
            to_company: None,
            to_org_unit: None,
            to_org_unit_id: None,
            to_position: None,
            expected_return_date: None,
            contract_end_date: None,
            leave_type: None,
            to_job_title_id: None,
            reason_code: None,
            to_workplace_id: None,
            classify: Default::default(),
            effective_date: effective_date.clone(),
            comment: ONBOARD_COMMENT.to_owned(),
            signoffs: EmployeeLifecycleSignoffs {
                privacy_notice_ack: true,
                korean_labor_law_ack: true,
                ..EmployeeLifecycleSignoffs::default()
            },
        };
        Some(json!(transition))
    } else {
        None
    };
    sqlx::query(
        r#"INSERT INTO employee_lifecycle_events (
            id, org_id, employee_id, event_type, from_status, to_status, to_company,
            to_org_unit, to_position, effective_date, comment, signoffs, created_by,
            to_org_unit_id, state, scheduled_request
        ) VALUES ($1, $2, $3, 'ONBOARD', $4, 'ACTIVE', $5, $6, $7, $8, $9,
            '{}'::jsonb, $10, $11, $12, $13)"#,
    )
    .bind(Uuid::new_v4())
    .bind(org_uuid)
    .bind(employee_id)
    .bind(scheduled.then_some("PRE_HIRE"))
    .bind(onboard.company)
    .bind(onboard.org_unit)
    .bind(onboard.position)
    .bind(&effective_date)
    .bind(ONBOARD_COMMENT)
    .bind(actor)
    .bind(onboard.org_unit_id)
    .bind(if scheduled { "SCHEDULED" } else { "APPLIED" })
    .bind(scheduled_request)
    .execute(tx.as_mut())
    .await
    .map_err(employee_create_db_error)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::is_pre_hire;
    use console_hr_domain::text::parse_yyyy_mm_dd;

    #[test]
    fn only_a_date_after_today_is_pre_hire() {
        let today = parse_yyyy_mm_dd("2026-10-04").unwrap();
        assert!(!is_pre_hire(None, today).unwrap());
        assert!(!is_pre_hire(Some("2026-10-04"), today).unwrap());
        assert!(!is_pre_hire(Some("2026-10-03"), today).unwrap());
        assert!(is_pre_hire(Some("2026-10-05"), today).unwrap());
        assert!(is_pre_hire(Some("2026-1-5"), today).is_err());
    }
}
