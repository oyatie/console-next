//! BW-19 4: the registration's ONBOARD. A hire date on or before today (KST)
//! records it APPLIED, as before; a later one makes the employee a pending
//! hire (PRE_HIRE) and stores the ONBOARD SCHEDULED, so the lifecycle runner
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

const ONBOARD_COMMENT_CODE: &str = "created_by_registration";

/// The ONBOARD a registration records.
#[derive(Clone, Copy)]
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
    record_registration_onboards(tx, org_uuid, actor, &[(employee_id, *onboard)], today).await
}

/// Inserts registrations and opens their cases together in the caller's transaction.
pub async fn record_registration_onboards(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: Uuid,
    onboards: &[(Uuid, RegistrationOnboard<'_>)],
    today: Date,
) -> Result<(), HrError> {
    if onboards.is_empty() {
        return Ok(());
    }
    let mut rows = Vec::with_capacity(onboards.len());
    let mut ids = Vec::with_capacity(onboards.len());
    for (employee_id, onboard) in onboards {
        let effective_date = onboard
            .hire_date
            .map_or_else(|| today.to_string(), str::to_owned);
        let scheduled = is_pre_hire(onboard.hire_date, today)?;
        let scheduled_request = if scheduled {
            // The runner re-validates every scheduled event with the base acks.
            // The registration is HR's own record of the hire, so it carries them;
            // the ledger row's `signoffs` stays `{}`, matching immediate ONBOARD.
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
                comment: String::new(),
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
        let event_id = Uuid::new_v4();
        ids.push(event_id);
        rows.push(
            json!({"id":event_id,"employee":employee_id,"company":onboard.company,
            "unit":onboard.org_unit,"position":onboard.position,"on_date":effective_date,
            "unit_id":onboard.org_unit_id,"scheduled":scheduled,"request":scheduled_request}),
        );
    }
    sqlx::query(
        "INSERT INTO employee_lifecycle_events (id,org_id,employee_id,event_type,from_status,to_status, \
         to_company,to_org_unit,to_position,effective_date,comment,signoffs,created_by,to_org_unit_id, \
         state,scheduled_request,comment_code) \
         SELECT r.id,$1,r.employee,'ONBOARD',CASE WHEN r.scheduled THEN 'PRE_HIRE' END,'ACTIVE', \
         r.company,r.unit,r.position,r.on_date,NULL,'{}'::jsonb,$2,r.unit_id, \
         CASE WHEN r.scheduled THEN 'SCHEDULED' ELSE 'APPLIED' END,r.request,$4 \
         FROM jsonb_to_recordset($3) r(id uuid,employee uuid,company text,unit text,position text, \
         on_date text,unit_id uuid,scheduled boolean,request jsonb)",
    ).bind(org_uuid).bind(actor).bind(json!(rows)).bind(ONBOARD_COMMENT_CODE)
        .execute(tx.as_mut()).await.map_err(employee_create_db_error)?;
    crate::cases::open::events_with_register(tx, org_uuid, &ids, None).await?;
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
