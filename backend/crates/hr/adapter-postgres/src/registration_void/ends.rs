//! Read-only end options return the permitted action and refusal code.
//! Writes revalidate the decision in their own transaction.

use console_hr_domain::registration_void::{VoidFacts, check_setup_delete, void_basis};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use console_settings_domain::SettingKey;
use serde::Serialize;
use uuid::Uuid;

use super::facts::{int_setting, lock, today_kst};
use crate::authz::{authorize_hr_org_wide, authorize_hr_scoped};
use crate::own_record::{OwnRecord, own_record_decision};
use crate::{HrError, HrService};

/// One way to end the record: offered, or refused with its code.
#[derive(Debug, Clone, Serialize)]
pub struct EndOffer {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal: Option<&'static str>,
}

impl EndOffer {
    fn of(refusal: Option<&'static str>) -> Self {
        Self {
            allowed: refusal.is_none(),
            refusal,
        }
    }
}

/// The two ways and what the sheet must ask.
#[derive(Debug, Clone, Serialize)]
pub struct EmployeeEndOptions {
    pub employee_id: Uuid,
    pub phase: &'static str,
    /// 등록 취소: `DELETE /employees/{id}` in SETUP, `POST …/void` after.
    pub cancel: EndOffer,
    /// `DELETE` or `VOID`.
    pub cancel_route: &'static str,
    /// The void needs 「근무한 적 없음」 (anyone but PRE_HIRE).
    pub attestation_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub void_basis: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded_hire_date: Option<String>,
    /// The SETUP delete of an EXITED person inside the 명부 period needs
    /// 「원본 명부 보관」 confirmed.
    pub register_confirmation_required: bool,
    /// 퇴직: report an exit case.
    pub exit: EndOffer,
    /// The open case to continue, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_exit_case_id: Option<Uuid>,
    /// The record's `updated_at`, the pin the cancel writes take.
    pub updated_at: String,
    pub can_cancel: bool,
    pub can_report_exit: bool,
}

/// The cancel routes as the wire names them (`DELETE /employees/{id}` in setup, the void after).
const ROUTE_SETUP: &str = "DELETE";
const ROUTE_VOID: &str = "VOID";

impl HrService {
    /// # Errors
    /// 403 without `employee_directory_read`; 404 for an unknown or voided record.
    pub async fn employee_end_options(
        &self,
        principal: &Principal,
        employee_id: Uuid,
    ) -> Result<EmployeeEndOptions, HrError> {
        authorize_hr_scoped(principal, Feature::EmployeeDirectoryRead)?;
        let can_cancel = authorize_hr_org_wide(principal, Feature::EmployeeDirectoryManage).is_ok();
        let can_report_exit = authorize_hr_scoped(principal, Feature::ExitCaseReport).is_ok();
        let org = *principal.org_id.as_uuid();
        let (tenant, actor) = (principal.org_id, principal.user_id);
        with_org_conn(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let phase: Option<String> =
                    sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id = $1")
                        .bind(org)
                        .fetch_optional(tx.as_mut())
                        .await?;
                let setup = phase.as_deref() == Some("SETUP");
                let locked = lock(tx, org, employee_id).await?;
                let today = today_kst(tx).await?;
                let (cancel, register, basis) = if setup {
                    let years =
                        int_setting(tx, org, SettingKey::RetentionLaborEmployeeRegister).await?;
                    let years = i32::try_from(years)
                        .map_err(|_| HrError::internal("retention setting is out of range"))?;
                    let needs = check_setup_delete(locked.exit_on(), today, years, false).is_err();
                    (None, needs, None)
                } else {
                    let window = int_setting(tx, org, SettingKey::PeopleVoidWindow).await?;
                    let facts = VoidFacts {
                        employment_status: &locked.status,
                        registered_on: locked.registered_on,
                        has_work_records: locked.has_work_records,
                    };
                    let basis = void_basis(facts, today, window, true);
                    (
                        basis.as_ref().err().and_then(|e| e.code),
                        false,
                        basis.ok().map(|b| b.as_str()),
                    )
                };
                let open_case: Option<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM employee_exit_cases WHERE org_id = $1 AND employee_id = $2 \
                       AND status NOT IN ('REJECTED','CANCELLED','SUBMITTED')",
                )
                .bind(org)
                .bind(employee_id)
                .fetch_optional(tx.as_mut())
                .await?;
                let scheduled: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM employee_lifecycle_events WHERE org_id = $1 \
                       AND employee_id = $2 AND event_type = 'TERMINATE' AND state = 'SCHEDULED')",
                )
                .bind(org)
                .bind(employee_id)
                .fetch_one(tx.as_mut())
                .await?;
                // people-self-33: one's own record offers neither way (Cedar `own_record`).
                let own =
                    own_record_decision(tx, tenant, actor, employee_id, Feature::ExitCaseReport)
                        .await?
                        == OwnRecord::Refused;
                let cancel = if own {
                    Some("own_record_forbidden")
                } else {
                    cancel
                };
                let exit = if own {
                    Some("own_record_forbidden")
                } else if locked.status == "EXITED" {
                    Some("employee_already_exited")
                } else if open_case.is_some() {
                    Some("exit_case_open")
                } else if scheduled {
                    Some("exit_already_scheduled")
                } else {
                    None
                };
                let updated_at = locked
                    .updated_at
                    .format(&time::format_description::well_known::Rfc3339)
                    .map_err(|_| HrError::internal("updated_at does not format"))?;
                Ok(EmployeeEndOptions {
                    employee_id,
                    phase: if setup { "SETUP" } else { "OPERATING" },
                    cancel: EndOffer::of(cancel),
                    cancel_route: if setup { ROUTE_SETUP } else { ROUTE_VOID },
                    attestation_required: !setup && locked.status != "PRE_HIRE" && cancel.is_none(),
                    void_basis: basis.filter(|_| cancel.is_none()),
                    recorded_hire_date: locked.recorded_hire_date,
                    register_confirmation_required: register,
                    exit: EndOffer::of(exit),
                    open_exit_case_id: open_case,
                    updated_at,
                    can_cancel,
                    can_report_exit,
                })
            })
        })
        .await
    }
}
