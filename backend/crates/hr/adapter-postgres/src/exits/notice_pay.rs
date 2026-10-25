// SPDX-License-Identifier: LicenseRef-Proprietary
//! Article 26 is a disposition: sufficient notice, pay in lieu, or an evidenced register ground.
use crate::{
    HrError,
    legal_rules::{LegalRule, rule},
};
use console_compliance_domain::statutory::codes;
use console_hr_domain::exits::clocks::{
    ExitClockRules, LossReportMonthAnchor, dismissal_notice_pay_owed,
};
use console_hr_domain::text::parse_yyyy_mm_dd;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use time::Date;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub enum NoticeDispositionKind {
    #[serde(rename = "PAY_IN_LIEU")]
    PayInLieu,
    #[serde(rename = "REGISTER_EXCEPTION")]
    RegisterException,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NoticeDisposition {
    pub kind: NoticeDispositionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ground_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_ref: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct NoticePay {
    pub owed: Option<bool>,
    pub notice_days: Option<i64>,
    pub required_days: Option<i64>,
    pub gap_days: Option<i64>,
    pub rule: LegalRule,
    pub minimum_service_rule: LegalRule,
    pub amount_won: Option<i64>,
    pub unavailable_reason: Option<&'static str>,
}
impl NoticePay {
    pub(super) fn accepts(&self, disposition: Option<&NoticeDisposition>) -> bool {
        if self.owed.is_none() {
            return false;
        }
        match disposition {
            Some(NoticeDisposition {
                kind: NoticeDispositionKind::PayInLieu,
                ground_code: None,
                evidence_ref: None,
            }) => true,
            Some(NoticeDisposition {
                kind: NoticeDispositionKind::RegisterException,
                ground_code: Some(ground_code),
                evidence_ref: Some(evidence_ref),
            }) => {
                !evidence_ref.trim().is_empty()
                    && evidence_ref.len() <= 1000
                    && self
                        .minimum_service_rule
                        .exception_grounds
                        .iter()
                        .any(|g| g["code"].as_str() == Some(ground_code.as_str()))
            }
            Some(_) => false,
            None => self.owed == Some(false),
        }
    }
    pub(super) fn refusal(&self) -> HrError {
        HrError {
            status: http::StatusCode::CONFLICT,
            code: "dismissal_notice_short",
            message: "dismissal notice requires pay in lieu or an evidenced statutory ground"
                .into(),
            errors: None,
            refusals: Some(Box::new(json!([self]))),
        }
    }
}
async fn count(conn: &mut PgConnection, code: &str, unit: &str, on: Date) -> Result<i64, HrError> {
    let r = rule(conn, code, on).await?;
    r.whole(unit).ok_or_else(|| HrError {
        status: http::StatusCode::CONFLICT,
        code: "dismissal_notice_short",
        message: "statutory rule is unavailable pending legal review".into(),
        errors: None,
        refusals: Some(Box::new(json!([{ "rule":r,"review_required":true }]))),
    })
}
/// Load every field from the register; the loss-day offset is already registered filing data.
async fn clocks(
    conn: &mut PgConnection,
    on: Date,
    days: u16,
    months: u8,
) -> Result<ExitClockRules, HrError> {
    let loss: Option<i16> = sqlx::query_scalar("SELECT (filing_rule->>'loss_offset_days')::smallint FROM statutory_rules WHERE code='ins.deadline.lose.iaci' AND effective_from <= $1 AND (effective_to_exclusive IS NULL OR $1 < effective_to_exclusive)")
        .bind(on).fetch_optional(&mut *conn).await?.flatten();
    let range = || HrError::validation("statutory clock value is out of range");
    Ok(ExitClockRules {
        final_pay_days: u16::try_from(count(conn, codes::FINAL_PAY_DUE_DAYS, "DAYS", on).await?)
            .map_err(|_| range())?,
        severance_pay_days: u16::try_from(
            count(conn, codes::SEVERANCE_PAY_DUE_DAYS, "DAYS", on).await?,
        )
        .map_err(|_| range())?,
        insurance_loss_offset_days: u16::try_from(loss.ok_or_else(range)?).map_err(|_| range())?,
        ei_nps_report_day: u8::try_from(
            count(
                conn,
                codes::EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH,
                "DAY_OF_NEXT_MONTH",
                on,
            )
            .await?,
        )
        .map_err(|_| range())?,
        ei_nps_report_anchor: LossReportMonthAnchor::ExitDate,
        nhis_report_days: u16::try_from(
            count(conn, codes::NHIS_LOSS_REPORT_DUE_DAYS, "DAYS", on).await?,
        )
        .map_err(|_| range())?,
        dismissal_notice_days: days,
        dismissal_notice_min_service_months: months,
    })
}
pub(super) async fn notice_pay(
    conn: &mut PgConnection,
    org: Uuid,
    employee: Uuid,
    exit: &str,
    served_on: Option<&str>,
    daily_wage: Option<i64>,
    case_id: Option<Uuid>,
) -> Result<NoticePay, HrError> {
    let on = parse_yyyy_mm_dd(exit)?;
    let rule = rule(conn, codes::DISMISSAL_NOTICE_DAYS, on).await?;
    let minimum_service_rule =
        crate::legal_rules::rule(conn, codes::DISMISSAL_NOTICE_MIN_SERVICE_MONTHS, on).await?;
    let required_days = rule.whole("DAYS");
    let min = minimum_service_rule
        .whole("MONTHS")
        .and_then(|v| u8::try_from(v).ok());
    let notice = served_on
        .filter(|s| !s.is_empty())
        .map(parse_yyyy_mm_dd)
        .transpose()?;
    let notice_days = notice.map(|d| (on - d).whole_days());
    let hire: Option<String> = sqlx::query_scalar(
        "SELECT COALESCE((SELECT h.hire_date::text FROM employment_heads h WHERE h.org_id=e.org_id AND h.employee_id=e.id AND h.hire_date <= $3 AND (h.exit_date IS NULL OR h.exit_date >= $3) AND NOT h.needs_confirmation ORDER BY h.hire_date DESC LIMIT 1), CASE WHEN e.hire_on <= $3 THEN e.hire_on::text END, (SELECT c.notice_service_start::text FROM employee_exit_cases c WHERE c.org_id=e.org_id AND c.id=$4 AND c.employee_id=e.id)) FROM person_employees_current e WHERE e.org_id=$1 AND e.id=$2",
    )
    .bind(org)
    .bind(employee)
    .bind(on)
    .bind(case_id)
    .fetch_one(&mut *conn)
    .await?;
    let owed = match (hire, required_days.and_then(|v| u16::try_from(v).ok()), min) {
        (Some(hire), Some(days), Some(months)) => {
            let rules = clocks(conn, on, days, months).await?;
            Some(dismissal_notice_pay_owed(
                parse_yyyy_mm_dd(&hire)?,
                notice,
                on,
                &rules,
            )?)
        }
        _ => None,
    };
    let amount_won = if owed == Some(true) {
        daily_wage
            .zip(required_days)
            .and_then(|(w, d)| w.checked_mul(d))
    } else {
        None
    };
    Ok(NoticePay {
        owed,
        notice_days,
        required_days,
        gap_days: required_days.map(|d| (d - notice_days.unwrap_or_default()).max(0)),
        rule,
        minimum_service_rule,
        amount_won,
        unavailable_reason: if owed.is_none() {
            Some("statutory_basis_unavailable")
        } else if owed == Some(true) && amount_won.is_none() {
            Some("ordinary_wage_missing")
        } else {
            None
        },
    })
}

pub(super) async fn case_notice_pay(
    conn: &mut PgConnection,
    org: Uuid,
    case: &mut super::types::EmployeeExitCaseResponse,
) -> Result<(), HrError> {
    if case.notice_required {
        case.notice_pay = Some(
            notice_pay(
                conn,
                org,
                case.employee_id,
                &case.effective_exit_date,
                case.dismissal_notice.as_ref().map(|n| n.served_on.as_str()),
                case.settlement_package
                    .as_ref()
                    .and_then(|p| p.ordinary_daily_wage_won),
                Some(case.id),
            )
            .await?,
        );
    }
    Ok(())
}
