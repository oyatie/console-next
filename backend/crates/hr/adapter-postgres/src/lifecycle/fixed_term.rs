//! BW-12 wiring: the two-year rule (기간제법 §4①) on CONTRACT_RENEWAL and the
//! employee's fixed-term service read.
//!
//! History, first match wins: the live labour-contract rows with an end date
//! (`employee_contracts`, EMP-MODEL G1); else the profile's contract window
//! (0245, which CONTRACT_RENEWAL extends) plus the windows earlier 고용형태
//! 전환 away from CONTRACT closed (MR-24); else `hire_date` (imported people,
//! flagged and never blocked). 육아휴직 is taken out (남녀고용평등법 §19⑤). The
//! limit is the statutory register's FIXED_TERM_MAX_YEARS on the renewal date.

use console_compliance_domain::statutory::codes;
use console_governance_adapter_postgres::PgGovernanceError;
use console_governance_adapter_postgres::exception::{
    GovernedWrite, consume_exception_conn, get_exception_conn,
};
use console_governance_domain::exception::{RuleCode, SubjectType};
use console_hr_domain::lifecycle::childcare::{AppliedEvent, childcare_periods};
use console_hr_domain::lifecycle::event::NormalizedEmployeeLifecycleTransition;
use console_hr_domain::lifecycle::fixed_term::{
    DatePeriod, FixedTermHistory, FixedTermService, RenewalVerdict, ServiceBasis, check_renewal,
    fixed_term_service,
};
use console_hr_domain::lifecycle::fixed_term_exemption::FixedTermExemption;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use serde_json::json;
use time::{Date, Duration};
use uuid::Uuid;

use super::classification::closed_contract_windows;
use super::title_reason::coded;
use crate::authz::authorize_hr_org_wide;
use crate::clock::today_kst;
use crate::{HrError, HrService};

/// hire_date, employment_type, contract_start_date, contract_end_date.
type Head = (Option<String>, Option<String>, Option<Date>, Option<Date>);

/// `GET /api/v1/employees/{id}/fixed-term`.
#[derive(Debug, Serialize)]
pub struct FixedTermView {
    /// False for an employee who is neither CONTRACT nor has a fixed-term row.
    pub applies: bool,
    pub cumulative_days: Option<u32>,
    pub two_year_date: Option<String>,
    /// CONTRACT_HISTORY or HIRE_DATE_FALLBACK (the latter needs a review).
    pub basis: Option<&'static str>,
}

struct Loaded {
    contracts: Vec<DatePeriod>,
    childcare: Vec<DatePeriod>,
    hire_date: Option<Date>,
    applies: bool,
    current_end: Option<Date>,
}

async fn load(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    employee: Uuid,
    as_of: Date,
) -> Result<Loaded, HrError> {
    let head: Option<Head> = sqlx::query_as(
        "SELECT e.hire_date, p.employment_type, p.contract_start_date, p.contract_end_date \
             FROM employees e LEFT JOIN employee_employment_profiles p \
               ON p.org_id = e.org_id AND p.employee_id = e.id \
             WHERE e.org_id = $1 AND e.id = $2",
    )
    .bind(org)
    .bind(employee)
    .fetch_optional(tx.as_mut())
    .await?;
    let (hire, employment_type, start, end) =
        head.ok_or_else(|| HrError::from_kernel(KernelError::not_found("employee not found")))?;
    let rows: Vec<(Date, Date)> = sqlx::query_as(
        "SELECT c.start_date, c.end_date FROM employee_contracts c \
         WHERE c.org_id = $1 AND c.employee_id = $2 AND c.end_date IS NOT NULL \
           AND c.kind IN ('FIXED_TERM', 'PART_TIME', 'DAILY') \
           AND NOT EXISTS (SELECT 1 FROM employee_contracts s \
                           WHERE s.org_id = c.org_id AND s.supersedes_id = c.id) \
         ORDER BY c.start_date",
    )
    .bind(org)
    .bind(employee)
    .fetch_all(tx.as_mut())
    .await?;
    let mut contracts: Vec<DatePeriod> = rows
        .into_iter()
        .map(|(start, end)| DatePeriod { start, end })
        .collect();
    if contracts.is_empty() {
        // MR-24: a window a 전환 away from CONTRACT closed still counts.
        contracts = closed_contract_windows(tx, org, employee).await?;
        if let (Some(start), Some(end)) = (start, end) {
            contracts.push(DatePeriod { start, end });
        }
    }
    let events: Vec<(String, Option<String>, String, Option<Date>)> = sqlx::query_as(
        "SELECT event_type, leave_type, effective_date, expected_return_date \
         FROM employee_lifecycle_events \
         WHERE org_id = $1 AND employee_id = $2 AND state = 'APPLIED' \
           AND event_type IN ('LEAVE_OF_ABSENCE', 'RETURN_FROM_LEAVE', 'TERMINATE') \
         ORDER BY effective_date, created_at",
    )
    .bind(org)
    .bind(employee)
    .fetch_all(tx.as_mut())
    .await?;
    let events: Vec<AppliedEvent<'_>> = events
        .iter()
        .filter_map(|(kind, leave, on, back)| {
            Some(AppliedEvent {
                event_type: kind,
                leave_type: leave.as_deref(),
                effective_date: parse_yyyy_mm_dd(on).ok()?,
                expected_return_date: *back,
            })
        })
        .collect();
    Ok(Loaded {
        applies: employment_type.as_deref() == Some("CONTRACT") || !contracts.is_empty(),
        childcare: childcare_periods(&events, as_of),
        hire_date: hire.as_deref().and_then(|d| parse_yyyy_mm_dd(d).ok()),
        current_end: end,
        contracts,
    })
}

/// The limit in force on `on`, from the statutory register (fail closed: no
/// row, two rows or a unit other than whole years is a server error).
// a direct SELECT of the global, SELECT-only register instead of
// console-compliance-adapter's validated load (one more adapter edge would
// push layer-boundary's rules.rs past the file-size ceiling).
async fn limit_months(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    on: Date,
) -> Result<u8, HrError> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT unit, value_num, value_den FROM statutory_rules \
         WHERE code = $1 AND effective_from <= $2 \
           AND (effective_to_exclusive IS NULL OR effective_to_exclusive > $2)",
    )
    .bind(codes::FIXED_TERM_MAX_YEARS)
    .bind(on)
    .fetch_all(tx.as_mut())
    .await?;
    match rows.as_slice() {
        [(unit, years, 1)] if unit == "YEARS" => {
            u8::try_from(years * 12).map_err(|_| HrError::internal("fixed-term limit out of range"))
        }
        _ => Err(HrError::internal(format!(
            "no single whole-year {} rule in force on {on}",
            codes::FIXED_TERM_MAX_YEARS
        ))),
    }
}

fn basis(service: &FixedTermService) -> &'static str {
    match service.basis {
        ServiceBasis::ContractHistory => "CONTRACT_HISTORY",
        ServiceBasis::HireDateFallback => "HIRE_DATE_FALLBACK",
    }
}

/// The employee's service as of `as_of`.
pub async fn fixed_term_view(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    employee: Uuid,
    as_of: Date,
) -> Result<FixedTermView, HrError> {
    let loaded = load(tx, org, employee, as_of).await?;
    let hire = loaded
        .hire_date
        .or_else(|| loaded.contracts.first().map(|p| p.start));
    let (true, Some(hire_date)) = (loaded.applies, hire) else {
        return Ok(FixedTermView {
            applies: loaded.applies,
            cumulative_days: None,
            two_year_date: None,
            basis: None,
        });
    };
    let history = FixedTermHistory {
        contracts: &loaded.contracts,
        childcare_leave: &loaded.childcare,
        hire_date,
    };
    let service = fixed_term_service(history, as_of, limit_months(tx, as_of).await?);
    Ok(FixedTermView {
        applies: true,
        cumulative_days: Some(service.cumulative_days),
        two_year_date: Some(service.two_year_date.to_string()),
        basis: Some(basis(&service)),
    })
}

/// A CONTRACT_RENEWAL that would take service past the limit is 409
/// `fixed_term_limit`, unless `exception_id` names a recorded or approved
/// FIXED_TERM_OVER_TWO_YEARS exception for this employee and renewal whose
/// reason code is one of the 기간제법 §4① 단서 grounds; that exception is
/// consumed here, in the write's transaction. The governed payload is
/// `{"employee_id", "contract_end_date"}`. Over the limit on the hire-date
/// fallback is allowed (the read flags it). A shortening is not checked.
pub async fn check_fixed_term_renewal(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    employee: Uuid,
    transition: &NormalizedEmployeeLifecycleTransition,
    exception_id: Option<Uuid>,
) -> Result<(), HrError> {
    let Some(new_end) = transition.contract_end_date.as_deref() else {
        return Ok(());
    };
    let new_end = parse_yyyy_mm_dd(new_end)?;
    let effective = parse_yyyy_mm_dd(&transition.effective_date)?;
    let loaded = load(tx, org, employee, effective).await?;
    let start = loaded
        .current_end
        .map_or(effective, |end| end + Duration::DAY);
    let hire = loaded
        .hire_date
        .or_else(|| loaded.contracts.first().map(|p| p.start));
    let (true, Some(hire_date), true) = (loaded.applies, hire, start <= new_end) else {
        return Ok(());
    };
    let history = FixedTermHistory {
        contracts: &loaded.contracts,
        childcare_leave: &loaded.childcare,
        hire_date,
    };
    let limit = limit_months(tx, effective).await?;
    let (verdict, service) = check_renewal(
        history,
        DatePeriod {
            start,
            end: new_end,
        },
        limit,
    );
    if verdict != RenewalVerdict::ExceedsLimit {
        return Ok(());
    }
    let Some(exception_id) = exception_id else {
        return Err(HrError {
            errors: None,
            status: http::StatusCode::CONFLICT,
            code: "fixed_term_limit",
            message: format!(
                "the renewal passes the fixed-term limit on {}; an exception citing a statutory ground is required",
                service.two_year_date
            ),
            refusals: None,
        });
    };
    let stored = get_exception_conn(tx.as_mut(), exception_id)
        .await
        .map_err(governance)?
        .ok_or_else(|| HrError::from_kernel(KernelError::not_found("exception not found")))?;
    if !FixedTermExemption::ALL
        .iter()
        .any(|g| g.code() == stored.reason_code)
    {
        return Err(coded(
            KernelError::validation("the exception must cite a 기간제법 §4① 단서 ground")
                .with_code("fixed_term_exemption_ground_invalid")
                .with_field("exception_id"),
        ));
    }
    let payload = json!({ "employee_id": employee, "contract_end_date": new_end.to_string() });
    let write = GovernedWrite {
        rule: RuleCode::FixedTermOverTwoYears,
        subject_type: SubjectType::Employee,
        subject_id: employee,
        payload: &payload,
        affected_periods: &[],
    };
    consume_exception_conn(tx.as_mut(), exception_id, &write)
        .await
        .map_err(governance)
}

/// The governance guard's refusals name themselves in the message
/// (`exception_consumed`, `exception_scope_changed`, …).
fn governance(error: PgGovernanceError) -> HrError {
    match error {
        PgGovernanceError::Domain(error) => coded(error),
        PgGovernanceError::Db(error) => HrError::from(error),
    }
}

impl HrService {
    /// `GET /api/v1/employees/{id}/fixed-term`: service as of today (KST).
    pub async fn employee_fixed_term(
        &self,
        principal: Principal,
        employee_id: Uuid,
    ) -> Result<FixedTermView, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
        let org = principal.org_id;
        let today = today_kst();
        with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move { fixed_term_view(tx, *org.as_uuid(), employee_id, today).await })
        })
        .await
    }
}
