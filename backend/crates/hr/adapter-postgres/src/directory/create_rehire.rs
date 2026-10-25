//! BW-19 2: 재입사. A former employee comes back as the same person (same
//! 사번, same history), not as a new one: a REHIRE lifecycle event starts a
//! new employment period on the EXITED head. A future first day makes them
//! 입사 예정 (PRE_HIRE) with a SCHEDULED ONBOARD, exactly as a registration.
//!
//! the canonical employment of the first period stays bound (the
//! legacy head carries the new period); a second canonical employment per
//! period comes with E-S3b's EmploymentAssignmentPort (LIFE).

use console_entity_adapter_postgres::employment_end::rehire_in_tx;
use console_entity_adapter_postgres::employment_moves::MoveWrite;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext, UserId};
use console_ontology_canonical_adapter_postgres::employee_intake::{
    RehirePeriod, start_rehire_period,
};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::Postgres;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::{authorize_hr_person, hr_reach};
use crate::clock::today_kst;
use crate::directory::create::require_assignable_org_unit;
use crate::directory::create_guard::{
    registration_key_reused, reserve_create_key, revalidate_directory_manager,
};
use crate::directory::create_onboard::{RegistrationOnboard, record_registration_onboard};
use crate::directory::create_rehire_input::{RehireEmployeeRequest, normalize_rehire};
use crate::directory::normalize::normalize_phone_e164;
use crate::directory::read_detail::load_employee_detail;
use crate::directory::types::EmployeeDetailResponse;
use crate::{HrError, HrService};

const REHIRE_COMMENT: &str = "Rehired through People & Workforce";

struct ExitedHead {
    company: String,
    exit_date: Option<String>,
    has_profile: bool,
}

/// company, status, exit date, merged into, has a profile.
type ExitedRow = (String, String, Option<String>, Option<Uuid>, bool);

async fn lock_exited_head(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_id: Uuid,
) -> Result<ExitedHead, HrError> {
    let row: Option<ExitedRow> = sqlx::query_as(
        "SELECT e.company, e.employment_status, e.exit_date::TEXT, e.merged_into_employee_id, \
                EXISTS (SELECT 1 FROM employee_employment_profiles p \
                        WHERE p.org_id = e.org_id AND p.employee_id = e.id) \
         FROM employees e WHERE e.org_id = $1 AND e.id = $2 FOR UPDATE OF e",
    )
    .bind(org_uuid)
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some((company, status, exit_date, merged_into, has_profile)) = row else {
        return Err(HrError::from_kernel(KernelError::not_found(
            "employee was not found in this organization",
        )));
    };
    if status != "EXITED" || merged_into.is_some() {
        return Err(HrError {
            errors: None,
            status: http::StatusCode::CONFLICT,
            code: "rehire_requires_exited",
            message: "only an EXITED employee can be rehired".to_owned(),
            refusals: Some(Box::new(json!([{ "status": status }]))),
        });
    }
    Ok(ExitedHead {
        company,
        exit_date,
        has_profile,
    })
}

/// Writes the profile of the new period: the employment type and contract
/// window replace the last period's, probation restarts empty.
async fn write_rehire_profile(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: UserId,
    employee_id: Uuid,
    request: &RehireEmployeeRequest,
    head: &ExitedHead,
    hash: &str,
) -> Result<(), HrError> {
    let contract_start = request
        .contract_end_date
        .as_ref()
        .map(|_| request.hire_date.as_str());
    if head.has_profile {
        sqlx::query(
            "UPDATE employee_employment_profiles SET employment_type = $3, \
                    contract_start_date = $4::DATE, contract_end_date = $5::DATE, \
                    probation_end_date = NULL, probation_confirmed_at = NULL, \
                    probation_confirmed_by = NULL \
             WHERE org_id = $1 AND employee_id = $2",
        )
        .bind(org_uuid)
        .bind(employee_id)
        .bind(&request.employment_type)
        .bind(contract_start)
        .bind(request.contract_end_date.as_deref())
        .execute(tx.as_mut())
        .await?;
        return Ok(());
    }
    let phone = request
        .phone
        .clone()
        .ok_or_else(|| {
            HrError::validation("phone is required when the former employee has no profile")
        })
        .and_then(normalize_phone_e164)?;
    let won = request.base_pay_won.ok_or_else(|| {
        HrError::validation("base_pay_won is required when the former employee has no profile")
    })?;
    let contracts = crate::contract::load_rows(tx, org_uuid, employee_id).await?;
    let hired = parse_yyyy_mm_dd(&request.hire_date)?;
    let pay_unit = request.pay_unit.as_deref().or_else(|| {
        console_hr_domain::contract::in_force(&contracts, hired)
            .map(|contract| contract.terms.pay_unit.as_str())
    });
    if won < 0 {
        return Err(HrError::validation("base_pay_won must not be negative"));
    }
    // Released clients can omit the unit; preserve the legacy amount without inventing a typed wage.
    sqlx::query(
        "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, \
             phone_e164, base_pay, base_pay_won, idempotency_key, request_hash, created_by, \
             contract_start_date, contract_end_date, pay_unit) \
         VALUES ($1, $2, $3, $4, $5::numeric, CASE WHEN $11::text IS NULL THEN NULL ELSE $5 END, \
                 $6, $7, $8, $9::DATE, $10::DATE, $11)",
    )
    .bind(employee_id)
    .bind(org_uuid)
    .bind(&request.employment_type)
    .bind(phone)
    .bind(won)
    .bind(&request.idempotency_key)
    .bind(hash)
    .bind(*actor.as_uuid())
    .bind(contract_start)
    .bind(request.contract_end_date.as_deref())
    .bind(pay_unit)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// The REHIRE ledger row: EXITED → ACTIVE on the first day, or → PRE_HIRE
/// today (its ONBOARD is then SCHEDULED for the first day).
#[allow(clippy::too_many_arguments)]
async fn record_rehire_event(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    actor: UserId,
    employee_id: Uuid,
    head: &ExitedHead,
    period: &RehirePeriod<'_>,
    effective_date: &str,
) -> Result<(), HrError> {
    let event_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employee_lifecycle_events (id, org_id, employee_id, event_type, from_status, \
             to_status, from_company, to_company, to_org_unit, to_position, effective_date, \
             comment, signoffs, created_by, to_org_unit_id) \
         VALUES ($1, $2, $3, 'REHIRE', 'EXITED', $4, $5, $6, $7, $8, $9, $10, '{}'::jsonb, $11, $12)",
    )
    .bind(event_id)
    .bind(org_uuid)
    .bind(employee_id)
    .bind(period.employment_status)
    .bind(&head.company)
    .bind(period.company)
    .bind(period.org_unit)
    .bind(period.position)
    .bind(effective_date)
    .bind(REHIRE_COMMENT)
    .bind(*actor.as_uuid())
    .bind(period.org_unit_id)
    .execute(tx.as_mut())
    .await?;
    crate::cases::open::event(tx, org_uuid, event_id).await?;
    Ok(())
}

impl HrService {
    /// 재입사: a new employment period for an EXITED person. Replays by
    /// `idempotency_key` (the registration reservation table).
    pub async fn rehire_employee(
        &self,
        principal: Principal,
        employee_id: Uuid,
        body: RehireEmployeeRequest,
    ) -> Result<(bool, EmployeeDetailResponse), HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let request = normalize_rehire(body)?;
        let org = principal.org_id;
        let actor = principal.user_id;
        let hash = request.request_hash(employee_id);
        with_audits::<_, _, HrError>(&self.pool, org, |tx| {
            Box::pin(async move {
                authorize_hr_person(
                    tx,
                    &principal,
                    Feature::EmployeeDirectoryManage,
                    employee_id,
                )
                .await?;
                let org_uuid = *org.as_uuid();
                revalidate_directory_manager(tx, org_uuid, actor).await?;
                if let Some(done) =
                    reserve_create_key(tx, org_uuid, &request.idempotency_key, &hash).await?
                {
                    if done != employee_id {
                        return Err(registration_key_reused());
                    }
                    let detail = load_employee_detail(tx, org_uuid, done).await?;
                    return Ok(((true, detail), Vec::new()));
                }
                let head = lock_exited_head(tx, org_uuid, employee_id).await?;
                super::rehire_guard::check(
                    tx.as_mut(),
                    org_uuid,
                    employee_id,
                    request.acknowledge_open_exit_case,
                )
                .await?;
                super::create_rehire_input::validate_period(
                    head.exit_date.as_deref(),
                    &request.hire_date,
                )?;
                sqlx::query("UPDATE employee_exit_cases c SET notice_service_start=e.hire_on FROM employees e WHERE c.org_id=$1 AND c.employee_id=$2 AND e.org_id=c.org_id AND e.id=c.employee_id AND c.notice_service_start IS NULL AND e.hire_on <= c.effective_exit_date")
                    .bind(org_uuid).bind(employee_id).execute(tx.as_mut()).await?;
                let org_unit =
                    require_assignable_org_unit(tx, org_uuid, request.org_unit_id).await?;
                let today = today_kst().to_string();
                let pre_hire = request.hire_date > today;
                let period = RehirePeriod {
                    employment_status: if pre_hire { "PRE_HIRE" } else { "ACTIVE" },
                    hire_date: &request.hire_date,
                    company: request.company.as_deref().unwrap_or(&head.company),
                    org_unit: &org_unit,
                    org_unit_id: request.org_unit_id,
                    position: &request.position,
                };
                if !start_rehire_period(tx, org_uuid, employee_id, &period).await? {
                    return Err(HrError::internal("the EXITED head moved under its lock"));
                }
                // UX-R3 STRUCT: the exit ended the last 법인 · 사업장 assignment; the new period is placed again.
                let write = MoveWrite {
                    org_id: org_uuid,
                    employee_id,
                    actor_id: *actor.as_uuid(),
                    command_id: Uuid::new_v4(),
                };
                let hired = parse_yyyy_mm_dd(&request.hire_date).map_err(HrError::from_kernel)?;
                rehire_in_tx(tx.as_mut(), write, request.org_unit_id, hired)
                    .await
                    .map_err(HrError::from_kernel)?;
                write_rehire_profile(tx, org_uuid, actor, employee_id, &request, &head, &hash)
                    .await?;
                let effective = if pre_hire { &today } else { &request.hire_date };
                record_rehire_event(tx, org_uuid, actor, employee_id, &head, &period, effective)
                    .await?;
                if pre_hire {
                    record_registration_onboard(
                        tx,
                        org_uuid,
                        *actor.as_uuid(),
                        employee_id,
                        &RegistrationOnboard {
                            company: period.company,
                            org_unit: &org_unit,
                            org_unit_id: Some(request.org_unit_id),
                            position: &request.position,
                            hire_date: Some(&request.hire_date),
                        },
                        today_kst(),
                    )
                    .await?;
                }
                sqlx::query(
                    "UPDATE employee_create_idempotency SET employee_id = $3 \
                     WHERE org_id = $1 AND idempotency_key = $2",
                )
                .bind(org_uuid)
                .bind(&request.idempotency_key)
                .bind(employee_id)
                .execute(tx.as_mut())
                .await?;
                let audit = AuditEvent::new(
                    Some(actor),
                    AuditAction::new("employee.rehire").map_err(HrError::from_kernel)?,
                    "employee",
                    employee_id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "hire_date": &request.hire_date,
                        "employment_type": &request.employment_type,
                        "org_unit_id": request.org_unit_id,
                        "pre_hire": pre_hire,
                        "acknowledge_open_exit_case": request.acknowledge_open_exit_case,
                    })),
                );
                let detail = load_employee_detail(tx, org_uuid, employee_id).await?;
                Ok(((false, detail), vec![audit]))
            })
        })
        .await
    }
}
