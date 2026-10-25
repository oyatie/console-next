// SPDX-License-Identifier: LicenseRef-Proprietary
//! One transactional guard for the report, confirmation and apply paths.
use super::notice::{DismissalNotice, missing_notice, notice_refusal};
use crate::{HrError, lifecycle::title_reason::coded};
use console_hr_application::lifecycle::hooks::{TerminationFacts, terminate_may_apply};
use console_hr_domain::exits::protection::{
    AppliedExitEvent, ProtectedPeriod, ProtectionRegister, ProtectionRule, protected_periods,
};
use console_hr_domain::lifecycle::childcare::AppliedEvent;
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{KernelError, OrgId};
use console_settings_domain::code_lists::ValidReason;
use serde::Serialize;
use serde_json::json;
use sqlx::{PgConnection, Row};
use time::{Date, Duration};
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct ProtectedPeriodView {
    pub lifecycle_event_id: Uuid,
    pub leave_type: String,
    pub leave_from: String,
    pub leave_until: Option<String>,
    pub protected_until: Option<String>,
    pub instrument: Option<String>,
    pub article: Option<String>,
    pub rule: Option<crate::legal_rules::LegalRule>,
}
impl From<&ProtectedPeriod> for ProtectedPeriodView {
    fn from(p: &ProtectedPeriod) -> Self {
        Self {
            lifecycle_event_id: p.lifecycle_event_id,
            leave_type: p.leave_type.clone(),
            leave_from: p.leave_from.to_string(),
            leave_until: p.leave_until.map(|d| d.to_string()),
            protected_until: p.protected_until.map(|d| d.to_string()),
            instrument: p.instrument.clone(),
            article: p.article.clone(),
            rule: None,
        }
    }
}
type LeaveRow = (Uuid, String, Option<String>, String, Option<Date>);
struct Rules {
    rows: Vec<sqlx::postgres::PgRow>,
    on: Date,
}
impl ProtectionRegister for Rules {
    fn rule(&self, leave_type: &str) -> Option<ProtectionRule> {
        let on = self.on;
        let mut rows = self.rows.iter().filter(|r| {
            r.get::<Vec<String>, _>("protection_leave_types")
                .iter()
                .any(|t| t == leave_type)
                && r.get::<Date, _>("effective_from") <= on
                && r.get::<Option<Date>, _>("effective_to_exclusive")
                    .is_none_or(|end| on < end)
        });
        let active = rows.next();
        // Outside sourced coverage, keep the refusal open and cite the register's law.
        let r = active.or_else(|| {
            self.rows
                .iter()
                .filter(|r| {
                    r.get::<Vec<String>, _>("protection_leave_types")
                        .iter()
                        .any(|t| t == leave_type)
                })
                .min_by_key(|r| r.get::<Date, _>("effective_from"))
        })?;
        let valid = active.is_some()
            && rows.next().is_none()
            && r.get::<String, _>("unit") == "DAYS"
            && r.get::<i64, _>("value_den") == 1;
        Some(ProtectionRule {
            tail_days: valid.then(|| r.get("value_num")),
            instrument: r.get("instrument_ko"),
            article: r.get("article_ko"),
        })
    }
}
/// The anti-join excludes rescinded/voided events; no malformed date is silently dropped.
pub(super) async fn load_protected_periods(
    conn: &mut PgConnection,
    org: Uuid,
    employee: Uuid,
    on: Date,
) -> Result<Vec<ProtectedPeriod>, HrError> {
    let rows: Vec<LeaveRow> = sqlx::query_as(
        "SELECT id,event_type,leave_type,effective_date,expected_return_date FROM employee_lifecycle_events l WHERE org_id=$1 AND employee_id=$2 AND state='APPLIED' AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.org_id=l.org_id AND v.voids_event_id=l.id) AND NOT EXISTS (SELECT 1 FROM employee_exit_cases c WHERE c.org_id=l.org_id AND c.exit_lifecycle_event_id=l.id AND c.status IN ('CANCELLED','REJECTED')) AND event_type IN ('LEAVE_OF_ABSENCE','RETURN_FROM_LEAVE','TERMINATE') ORDER BY effective_date,created_at,id")
        .bind(org).bind(employee).fetch_all(&mut *conn).await?;
    let events = rows
        .iter()
        .map(|(id, kind, leave, on, back)| {
            Ok(AppliedExitEvent {
                lifecycle_event_id: *id,
                event: AppliedEvent {
                    event_type: kind,
                    leave_type: leave.as_deref(),
                    effective_date: parse_yyyy_mm_dd(on)?,
                    expected_return_date: *back,
                },
            })
        })
        .collect::<Result<Vec<_>, KernelError>>()?;
    let rules = Rules { on, rows: sqlx::query("SELECT code,protection_leave_types,effective_from,effective_to_exclusive,unit,value_num,value_den,instrument_ko,article_ko FROM statutory_rules WHERE cardinality(protection_leave_types) > 0")
        .fetch_all(conn).await? };
    Ok(protected_periods(&events, &rules))
}
pub(super) fn termination_date(exit_date: &str) -> Result<Date, HrError> {
    parse_yyyy_mm_dd(exit_date)?
        .checked_add(Duration::days(1))
        .ok_or_else(|| HrError::validation("effective_exit_date is out of range"))
}
/// Report checks protection early; written evidence gates confirmation and effect.
#[allow(clippy::too_many_arguments)]
pub(super) async fn check_exit_guards(
    conn: &mut PgConnection,
    org: OrgId,
    employee: Uuid,
    exit_date: &str,
    class: &ValidReason,
    notice: Option<&DismissalNotice>,
    stage: &'static str,
    disposition: Option<&super::notice_pay::NoticeDisposition>,
) -> Result<(), HrError> {
    if !class.involuntary {
        return Ok(());
    }
    // Serialize with lifecycle writers, including leaves recorded after confirmation.
    sqlx::query("SELECT id FROM employees WHERE org_id=$1 AND id=$2 FOR UPDATE")
        .bind(org.as_uuid())
        .bind(employee)
        .fetch_one(&mut *conn)
        .await?;
    let date = termination_date(exit_date)?;
    let periods = load_protected_periods(conn, *org.as_uuid(), employee, date).await?;
    let facts = TerminationFacts {
        involuntary: class.involuntary,
        notice_required: class.notice_required && stage != "report",
        notice: notice.map(DismissalNotice::facts),
        protected_periods: &periods,
        termination_date: date,
    };
    let Err(error) = terminate_may_apply(Some(&facts)) else {
        if class.notice_required && stage != "report" {
            let pay = super::notice_pay::notice_pay(
                conn,
                *org.as_uuid(),
                employee,
                exit_date,
                notice.map(|n| n.served_on.as_str()),
                None,
                None,
            )
            .await?;
            if !pay.accepts(disposition) {
                record_refusal(org, employee, stage, "dismissal_notice_short");
                return Err(pay.refusal());
            }
        }
        return Ok(());
    };
    let error = if error.code == Some("exit_protected_period") {
        HrError {
            refusals: Some(Box::new(json!(
                protection_views(conn, &periods, date).await?
            ))),
            ..coded(error)
        }
    } else {
        notice_refusal(missing_notice(notice, date))
    };
    record_refusal(org, employee, stage, error.code);
    Err(error)
}
pub(super) fn record_refusal(org: OrgId, employee: Uuid, stage: &'static str, code: &'static str) {
    metrics::counter!("hr_exit_guard_refusals_total", "code" => code, "stage" => stage)
        .increment(1);
    let support_ref = console_platform_db::command_context::execution();
    tracing::warn!(%org, %employee, stage, code, ?support_ref, "exit guard refused");
}

/// A single-case read carries only periods blocking its own statutory exit date.
pub(super) async fn case_protection(
    conn: &mut PgConnection,
    org: Uuid,
    case: &mut super::types::EmployeeExitCaseResponse,
) -> Result<(), HrError> {
    let date = termination_date(&case.effective_exit_date)?;
    let periods = load_protected_periods(conn, org, case.employee_id, date).await?;
    case.protected_periods = protection_views(conn, &periods, date).await?;
    super::notice_pay::case_notice_pay(conn, org, case).await?;
    Ok(())
}

pub(super) async fn protection_views(
    conn: &mut PgConnection,
    periods: &[ProtectedPeriod],
    on: Date,
) -> Result<Vec<ProtectedPeriodView>, HrError> {
    let rules = crate::legal_rules::leave_rules(conn, on).await?;
    Ok(periods
        .iter()
        .filter(|p| p.blocks(on))
        .map(|p| {
            let mut view = ProtectedPeriodView::from(p);
            view.rule = rules
                .iter()
                .find(|r| r.leave_type == p.leave_type)
                .map(|r| r.rule.clone());
            view
        })
        .collect())
}
