//! Employee detail read and the lifecycle events it offers (moved from
//! `app/src/hr.rs`, R2-people).

use console_hr_domain::lifecycle::schedule::SCHEDULABLE_LIFECYCLE_EVENT_TYPES;
use console_hr_domain::lifecycle::signoffs::required_lifecycle_signoffs;
use console_hr_domain::lifecycle::transition::{
    RECORDABLE_LIFECYCLE_EVENT_TYPES, default_lifecycle_status,
};
use console_hr_domain::text::normalize_enum_text;
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde::Serialize;
use serde_json::json;
use sqlx::{Postgres, Row};
use uuid::Uuid;

use crate::authz::{Tier, authorize_hr_person_in, hr_may_person_in, hr_reach_in};
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::directory::read_list::employee_from_row;
use crate::directory::types::{
    EmployeeClassification, EmployeeDetailResponse, EmployeeEmploymentDetail,
};
use crate::lifecycle::rules::lifecycle_state_rule;
use crate::metrics::record_hr_read;
use crate::own_record::{OwnRecord, own_record_decision};
use crate::{
    HrError, HrService, assignment_lateral, failed_event_lateral, leave_return_lateral,
    status_since_lateral,
};

/// One lifecycle event the server would accept for this employee right now,
/// with the acknowledgements it requires. Computed by the same rules the
/// lifecycle endpoint enforces, so the console never mirrors them.
#[derive(Debug, Serialize)]
pub struct AllowedLifecycleEvent {
    pub event_type: &'static str,
    pub required_signoffs: &'static [&'static str],
    /// TRANSFER only: the acknowledgements when `to_company` changes company.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross_company_required_signoffs: Option<&'static [&'static str]>,
}

/// What `allowed_events` reports: every recordable event the state rule admits
/// for this status and employment type, with its acks.
pub fn allowed_lifecycle_events(
    current_status: &str,
    employment_type: Option<&str>,
) -> Vec<AllowedLifecycleEvent> {
    RECORDABLE_LIFECYCLE_EVENT_TYPES
        .into_iter()
        .filter(|event| {
            let to = match default_lifecycle_status(event) {
                "" => current_status,
                to => to,
            };
            lifecycle_state_rule(current_status, employment_type, event, to).is_ok()
        })
        .map(|event| AllowedLifecycleEvent {
            event_type: event,
            required_signoffs: required_lifecycle_signoffs(event, false),
            cross_company_required_signoffs: (event == "TRANSFER")
                .then(|| required_lifecycle_signoffs(event, true)),
        })
        .collect()
}

pub async fn load_employee_detail(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_id: Uuid,
    employee_id: Uuid,
) -> Result<EmployeeDetailResponse, HrError> {
    let row = sqlx::query(concat!(
        r#"SELECT e.id, e.company, COALESCE(console_employee_facts(e.org_id,e.id)->>'legal_name',e.name) AS name, console_employee_person(e.org_id,e.id) AS person_id, e.employee_number, e.org_unit, e.org_unit_id, e.job,
            e.position, e.worksite_name, e.worksite_address, to_char(e.hire_on, 'YYYY-MM-DD') AS hire_date, to_char(e.exit_on, 'YYYY-MM-DD') AS exit_date,
            e.employment_status AS recorded_status, entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AS employment_status, ss.status_since, e.leave_accrued::TEXT AS leave_accrued,
            e.leave_used::TEXT AS leave_used, e.leave_remaining::TEXT AS leave_remaining,
            b.id AS home_branch_id, b.name AS home_branch_name,
            e.identity_resolution_strategy, e.identity_resolution_confidence,
            e.identity_review_required, e.identity_name_only_merge, e.work_email,
            e.created_at, e.updated_at, ea.legal_entity_id, ea.workplace_id, p.employee_id AS profile_employee_id,
            p.employment_type, CASE WHEN console_employee_facts(e.org_id,e.id) ? 'phone' THEN console_employee_facts(e.org_id,e.id)->>'phone' ELSE p.phone_e164 END AS phone_e164, p.base_pay::TEXT AS base_pay, p.currency,
            p.contract_start_date::TEXT AS contract_start_date,
            p.contract_end_date::TEXT AS contract_end_date, lr.expected_return_date,
            ne.id AS next_event_id, ne.event_type AS next_event_type,
            ne.effective_date AS next_event_date,
            fe.id AS failed_event_id, fe.event_type AS failed_event_type,
            fe.effective_date AS failed_event_date, fe.failure_code AS failed_event_code,
            se.to_status AS scheduled_status, se.effective_date AS scheduled_until,
            e.grade_id, e.job_title_id, e.position_kind_id, e.job_id, e.job_family_id, "#,
        crate::register_review_sql!(),
        r#" AS register_review_required, cp.employee_id IS NULL AS home_branch_review_required
        FROM person_employees_current e
        LEFT JOIN employee_employment_profiles p ON p.employee_id = e.id AND p.org_id = e.org_id
        LEFT JOIN branches b ON b.id = e.home_branch_id AND b.org_id = e.org_id AND b.deactivated_at IS NULL
        LEFT JOIN LATERAL (SELECT n.id, n.event_type, n.effective_date
            FROM employee_lifecycle_events n
            WHERE n.org_id = e.org_id AND n.employee_id = e.id AND n.state = 'SCHEDULED'
            ORDER BY n.effective_date, n.created_at LIMIT 1) ne ON TRUE
        LEFT JOIN LATERAL (SELECT n.to_status, n.effective_date
            FROM employee_lifecycle_events n
            WHERE n.org_id = e.org_id AND n.employee_id = e.id AND n.state = 'SCHEDULED'
            ORDER BY n.effective_date DESC, n.created_at DESC LIMIT 1) se ON TRUE"#,
        failed_event_lateral!(),
        leave_return_lateral!(),
        status_since_lateral!(),
        assignment_lateral!(),
        crate::current_placement_join!(),
        " WHERE e.org_id = $1 AND e.id = $2"),
    ).bind(org_id).bind(employee_id).fetch_optional(tx.as_mut()).await?
        .ok_or_else(|| HrError::from_kernel(KernelError::not_found("employee was not found in this organization")))?;
    // Roster-import rows have no employment profile: `employment` is null
    // rather than the whole employee reading as not found.
    let employment = match row.try_get::<Option<Uuid>, _>("profile_employee_id")? {
        Some(_) => Some(EmployeeEmploymentDetail {
            employment_type: row.try_get("employment_type")?,
            // Optional since MR-7: an imported profile records neither.
            phone_e164: row.try_get("phone_e164")?,
            base_pay: row.try_get("base_pay")?,
            currency: row.try_get("currency")?,
            contract_start_date: row.try_get("contract_start_date")?,
            contract_end_date: row.try_get("contract_end_date")?,
        }),
        None => None,
    };
    let classification = EmployeeClassification {
        grade_id: row.try_get("grade_id")?,
        job_title_id: row.try_get("job_title_id")?,
        position_kind_id: row.try_get("position_kind_id")?,
        job_id: row.try_get("job_id")?,
        job_family_id: row.try_get("job_family_id")?,
    };
    let status: Option<String> = row.try_get("recorded_status")?;
    let employment_type: Option<String> = row.try_get("employment_type")?;
    // As the employee will stand after their last SCHEDULED event (its stored
    // status is the one validated against the projected timeline).
    let scheduled_status: Option<String> = row.try_get("scheduled_status")?;
    let schedule_after: Option<String> = row.try_get("scheduled_until")?;
    let allowed_scheduled_events = match &scheduled_status {
        Some(projected) => allowed_lifecycle_events(
            &normalize_enum_text(projected.clone()),
            employment_type.as_deref(),
        )
        .into_iter()
        .filter(|allowed| SCHEDULABLE_LIFECYCLE_EVENT_TYPES.contains(&allowed.event_type))
        .collect(),
        None => Vec::new(),
    };
    let employee = employee_from_row(row)?;
    let warnings = super::read_warnings::current_warnings(tx, org_id, &employee).await?;
    let retention = if employee.status.as_deref() == Some("EXITED") {
        let exit = employee
            .exit_date
            .as_deref()
            .map(console_hr_domain::text::parse_yyyy_mm_dd)
            .transpose()?;
        let rule = crate::legal_rules::rule(
            tx.as_mut(),
            console_compliance_domain::statutory::codes::EMPLOYMENT_RECORD_RETENTION_YEARS,
            exit.unwrap_or_else(crate::clock::today_kst),
        )
        .await?;
        let kept_until = exit
            .zip(rule.whole("YEARS").and_then(|v| i32::try_from(v).ok()))
            .map(|(exit, years)| {
                console_hr_domain::registration_void::register_kept_until(exit, years).to_string()
            });
        Some(crate::directory::types::EmployeeRetention { kept_until, rule })
    } else {
        None
    };
    let rehire_exit_case = if employee.status.as_deref() == Some("EXITED") {
        super::rehire_guard::latest(tx.as_mut(), org_id, employee_id).await?
    } else {
        None
    };
    Ok(EmployeeDetailResponse {
        rehire_exit_case,
        retention,
        employee,
        pending_employment: employment
            .as_ref()
            .filter(|profile| profile.employment_type.is_none())
            .cloned(),
        employment,
        allowed_events: allowed_lifecycle_events(
            &normalize_enum_text(status.unwrap_or_default()),
            employment_type.as_deref(),
        ),
        allowed_scheduled_events,
        schedule_after,
        classification,
        warnings,
    })
}

impl HrService {
    pub async fn employee_detail(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<EmployeeDetailResponse, HrError> {
        // AX-5: refuse a holder of nothing before any read.
        hr_reach_in(&principal, Feature::EmployeeDirectoryRead, Tier::Branch)?;
        record_hr_read("employee_detail");
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let reader = principal.clone();
        let detail = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                // AX-5: outside the reader's grant set — or no such person —
                // is one `out_of_scope` (no existence leak), and nothing was
                // shown, so no 접속기록 row.
                authorize_hr_person_in(
                    tx,
                    &reader,
                    Feature::EmployeeDirectoryRead,
                    employee_id,
                    Tier::Branch,
                )
                .await?;
                let detail = load_employee_detail(tx, org_uuid, employee_id).await?;
                let manager = hr_may_person_in(
                    tx,
                    &reader,
                    Feature::EmployeeDirectoryManage,
                    employee_id,
                    Tier::Branch,
                )
                .await?;
                let me = actor_employee_id(tx, &reader).await?;
                // people-self-33: nothing is recordable on one's own record.
                let mut detail = detail;
                super::read_warnings::visible_warnings(tx, &reader, &mut detail.warnings).await?;
                let (org, actor) = (reader.org_id, reader.user_id);
                let manage = Feature::EmployeeDirectoryManage;
                if own_record_decision(tx, org, actor, employee_id, manage).await?
                    == OwnRecord::Refused
                {
                    detail.allowed_events.clear();
                    detail.allowed_scheduled_events.clear();
                }
                let event = access_event(
                    &reader,
                    DirectoryAccess::Detail,
                    &[employee_id],
                    me,
                    json!({}),
                )?;
                Ok(((detail, manager), vec![event]))
            })
        })
        .await?;
        let (detail, manager) = detail;
        Ok(if manager {
            detail
        } else {
            detail.redact_for_reader()
        })
    }
}
