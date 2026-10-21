//! Exit-case request and response types (moved from `app/src/hr.rs`, R2-exits).

use console_hr_domain::exits::next_actions::ExitCaseNextAction;
use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
use console_platform_authz::{Feature, Principal};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::authorize_hr_scoped_write;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReportEmployeeExitCaseRequest {
    pub employee_id: Uuid,
    #[serde(default)]
    pub branch_id: Option<Uuid>,
    #[serde(default)]
    pub absence_alert_id: Option<Uuid>,
    pub effective_exit_date: String,
    pub site_manager_note: String,
    /// 퇴직 사유 (BW-07 `exit_reason` catalog), asked at the report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_reason_code: Option<String>,
}

/// Unknown fields are refused: the retired `decision: "REJECT"` must fail
/// loudly (422) instead of being ignored and confirming the exit.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfirmEmployeeExitCaseRequest {
    #[serde(default)]
    pub hq_confirmation: bool,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub settlement_input: Option<ExitSettlementInput>,
    /// HR tier only: the TERMINATE acknowledgements (all four are required).
    #[serde(default)]
    pub signoffs: EmployeeLifecycleSignoffs,
    /// HQ tier under `approval.policy.exit = route`, when the tenant ops
    /// account confirms its own HR confirmation (decisions #26 item d): a
    /// step-up bound to [`crate::exits::confirm::exit_hq_binding`].
    #[serde(default)]
    pub step_up: Option<console_platform_auth::MobilePasskeyStepUpEnvelope>,
}

/// Body of `POST /hr/exit-cases/{id}/reject` and `/cancel`.
#[derive(Debug, Deserialize)]
pub struct CloseEmployeeExitCaseRequest {
    pub reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftEmployeeExitApprovalRequest {
    #[serde(default)]
    pub submit: bool,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub settlement_input: Option<ExitSettlementInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExitSettlementInput {
    pub average_wage_period_start: String,
    pub average_wage_period_end: String,
    pub average_wage_calendar_days: i64,
    pub average_wage_total_won: i64,
    /// Monthly 통상임금 (ordinary wage) in won, gathered alongside the average-wage
    /// source fields. Mandatory (no `#[serde(default)]`): the request fails to
    /// deserialize when absent, so the statutory 통상임금 floor can never be
    /// silently skipped for the depressed-window absence→exit population.
    pub monthly_ordinary_wage_won: i64,
}

#[derive(Debug, Serialize)]
pub struct EmployeeExitCaseResponse {
    pub id: Uuid,
    pub employee_id: Uuid,
    pub employee_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub employee_number: Option<String>,
    pub company: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worksite_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub absence_alert_id: Option<Uuid>,
    pub status: String,
    pub effective_exit_date: String,
    pub site_manager_note: String,
    /// The report's 퇴직 사유 code; omitted when the report gave none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_reason_code: Option<String>,
    pub reported_by: Uuid,
    /// Display names for the actor ids, resolved within the tenant; null when
    /// the actor is unset or unknown.
    pub reported_by_name: Option<String>,
    pub hr_confirmed_by_name: Option<String>,
    pub hq_confirmed_by_name: Option<String>,
    pub approval_submitted_by_name: Option<String>,
    pub closed_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub reported_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hr_confirmed_by: Option<Uuid>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub hr_confirmed_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hq_confirmed_by: Option<Uuid>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub hq_confirmed_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_submitted_by: Option<Uuid>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub approval_submitted_at: Option<OffsetDateTime>,
    /// Who rejected or cancelled the case, when, and why (REJECTED/CANCELLED only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_by: Option<Uuid>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub closed_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement_package: Option<EmployeeExitSettlementPackageResponse>,
    /// The TERMINATE lifecycle event HR confirmation recorded, and its state:
    /// SCHEDULED until an exit dated after the confirmation takes effect.
    pub exit_lifecycle_event_id: Option<Uuid>,
    pub exit_event_state: Option<String>,
    pub next_actions: Vec<ExitCaseNextAction>,
    /// The settlement deadlines from the statutory register (the case read only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement_deadlines: Option<Vec<ExitSettlementDeadline>>,
}

/// One payment the leaving employer settles: open from `opens_on` (the
/// 퇴직일), due by `due_date` (RELEASED, or HOLD before a qualified review;
/// UNKNOWN never carries a date), under the cited article.
#[derive(Debug, Serialize)]
pub struct ExitSettlementDeadline {
    /// FINAL_PAY (금품청산) or SEVERANCE_PAY (퇴직금).
    pub kind: &'static str,
    pub opens_on: Option<String>,
    pub due_date: Option<String>,
    /// Days from today (KST) to `due_date`; negative once overdue.
    pub due_in_days: Option<i64>,
    pub deadline_status: &'static str,
    pub instrument: Option<String>,
    pub article: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EmployeeExitSettlementPackageResponse {
    pub id: Uuid,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_days: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_wage_period_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_wage_period_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_wage_calendar_days: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_wage_total_won: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_daily_wage_milliwon: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severance_pay_won: Option<i64>,
    /// 통상임금 (ordinary-wage) statutory basis (0093 review HIGH #2): the monthly
    /// ordinary wage a reviewer signs, the 통상일급 derived from it via the 209h/8h
    /// rule, and the daily wage that actually governed severance = max(average,
    /// ordinary). Persisted, digest-covered, and exposed so the money trail is
    /// auditable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monthly_ordinary_wage_won: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordinary_daily_wage_won: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statutory_daily_wage_milliwon: Option<i64>,
    pub missing_source_fields: Vec<String>,
    pub statutory_basis: Value,
    /// The generated MOEL/NHIS insurance-loss document. Also carries a
    /// `certification_status` key (stamped by `exit_case_from_row`, mirroring
    /// the field below) so the document itself never omits the uncertified
    /// marker even if forwarded independently of this DTO.
    pub insurance_loss_payload: Value,
    /// The generated approval-submission document. Same
    /// `certification_status` stamping as `insurance_loss_payload`.
    pub approval_payload: Value,
    /// EFFECTIVE certification state (single source for the "산정 초안 — 노무사
    /// 검증 전" label): reported `CERTIFIED` only when the stored
    /// `certification_status` is CERTIFIED AND the stored digest still binds the
    /// current numbers; a stale/absent digest is reported `UNCERTIFIED_DRAFT`.
    pub certification_status: String,
    #[serde(with = "time::serde::rfc3339")]
    pub generated_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submitted_by: Option<Uuid>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub submitted_at: Option<OffsetDateTime>,
    /// True when the reader lacks `exit_settlement_manage` over the case's
    /// branch (BW-26): every pay figure is omitted, the basis is `{}` and the
    /// two documents keep only `certification_status`. Omitted when false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub figures_withheld: bool,
}

impl EmployeeExitSettlementPackageResponse {
    fn withhold_figures(&mut self) {
        self.average_wage_total_won = None;
        self.average_daily_wage_milliwon = None;
        self.severance_pay_won = None;
        self.monthly_ordinary_wage_won = None;
        self.ordinary_daily_wage_won = None;
        self.statutory_daily_wage_milliwon = None;
        self.statutory_basis = json!({});
        let marker = json!({ "certification_status": &self.certification_status });
        self.insurance_loss_payload = marker.clone();
        self.approval_payload = marker;
        self.figures_withheld = true;
    }
}

impl EmployeeExitCaseResponse {
    /// Value-based masking (BW-26, prototype-parity J7 「팀장 sees no 급여」):
    /// the settlement's pay figures reach only a holder of the capability that
    /// writes them, over this case's branch. Every case response passes here.
    #[must_use]
    pub fn for_reader(mut self, principal: &Principal) -> Self {
        let pay_reader =
            authorize_hr_scoped_write(principal, Feature::ExitSettlementManage, self.branch_id)
                .is_ok();
        if !pay_reader && let Some(package) = self.settlement_package.as_mut() {
            package.withhold_figures();
        }
        self
    }
}

#[derive(Debug, Serialize)]
pub struct EmployeeExitCasePage {
    pub items: Vec<EmployeeExitCaseResponse>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Deserialize)]
pub struct ExitCaseListQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub employee_id: Option<Uuid>,
    /// One status or a comma-separated list (`status=REPORTED,HR_CONFIRMED`).
    pub status: Option<String>,
    /// Part of the employee's name or employee number (PEOPLE-B, HR §10 A7).
    pub search: Option<String>,
}

#[cfg(test)]
#[path = "types_unknown_fields.rs"]
mod unknown_fields_tests;
