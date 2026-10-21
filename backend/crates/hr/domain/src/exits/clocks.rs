//! Exit legal clocks (BW-05): the due dates an exit case serves to the case
//! card and the action inbox. The server computes them here; clients never do.
//!
//! Every statutory number arrives in [`ExitClockRules`], loaded by the caller
//! from the `statutory_rules` register (HOLD rows until a 노무사 lifts them).
//! Where a day count is ambiguous, the register carries the earlier reading.

use console_kernel_core::KernelError;
use time::{Date, Duration};

/// Which date's month starts the 고용보험/국민연금 상실신고 clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LossReportMonthAnchor {
    /// The month of `exit_date`: the earlier reading, kept until confirmed.
    /// It differs from [`Self::LossDate`] only for a month-end exit.
    ExitDate,
    /// The month of the 상실일.
    LossDate,
}

/// Statutory numbers for the exit clocks, one field per register row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitClockRules {
    /// 근기법 §36 금품청산: days after `exit_date`.
    pub final_pay_days: u16,
    /// 근퇴법 §9 퇴직금: days after `exit_date`.
    pub severance_pay_days: u16,
    /// 상실일 = 퇴직일 다음날: days after `exit_date`.
    pub insurance_loss_offset_days: u16,
    /// 고용보험법 시행령 §7①, 국민연금법 시행규칙 §6: day of the following month.
    pub ei_nps_report_day: u8,
    /// Which month the following month is counted from.
    pub ei_nps_report_anchor: LossReportMonthAnchor,
    /// 건보법 §9①3·②, §10②; 시행규칙 §4① 단서·④2: days after `exit_date`.
    pub nhis_report_days: u16,
    /// 근기법 §26: notice owed before a dismissal, in days.
    pub dismissal_notice_days: u16,
    /// 근기법 §26 단서: below this many months of service no notice is owed.
    pub dismissal_notice_min_service_months: u8,
}

/// Every calendar clock an exit starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitClocks {
    pub insurance_loss_date: Date,
    pub final_pay_due: Date,
    /// 근기법 §48②: the final 임금명세서 goes out with the final pay.
    pub final_payslip_due: Date,
    pub severance_due: Date,
    /// 고용보험 and 국민연금 상실신고. 산재 follows 고용보험 until confirmed.
    pub ei_nps_loss_report_due: Date,
    pub nhis_loss_report_due: Date,
    /// 소득세법 §137 중도퇴사 연말정산, settled in the final pay [U].
    /// A payroll-owned queue item linked to the case.
    pub mid_year_tax_settlement_due: Date,
}

/// Computes every calendar clock for a 마지막 근무일 of `exit_date`.
///
/// # Errors
/// Validation when a computed date leaves the supported calendar range, or the
/// register's report day does not exist in the due month.
pub fn exit_clocks(exit_date: Date, rules: &ExitClockRules) -> Result<ExitClocks, KernelError> {
    let final_pay_due = due_after_days(exit_date, rules.final_pay_days)?;
    let insurance_loss_date = due_after_days(exit_date, rules.insurance_loss_offset_days)?;
    let anchor = match rules.ei_nps_report_anchor {
        LossReportMonthAnchor::ExitDate => exit_date,
        LossReportMonthAnchor::LossDate => insurance_loss_date,
    };
    let ei_nps_loss_report_due = add_months(anchor, 1)?
        .replace_day(rules.ei_nps_report_day)
        .map_err(|_| out_of_range())?;
    Ok(ExitClocks {
        insurance_loss_date,
        final_pay_due,
        final_payslip_due: final_pay_due,
        severance_due: due_after_days(exit_date, rules.severance_pay_days)?,
        ei_nps_loss_report_due,
        nhis_loss_report_due: due_after_days(exit_date, rules.nhis_report_days)?,
        mid_year_tax_settlement_due: final_pay_due,
    })
}

/// 근기법 §26 gap line: whether a 해고예고수당 line is owed.
///
/// The gap is measured from `notice_date` to `exit_date`, the
/// worker-favourable reading until a 노무사 confirms; no notice at all
/// (`None`) is always short. Service is counted to
/// the 상실일 (`exit_date + 1`), the convention 퇴직금 eligibility uses, with
/// month-end clamping (11/30 + 3 months = the last day of February).
///
/// # Errors
/// Validation when a computed date leaves the supported calendar range.
pub fn dismissal_notice_pay_owed(
    hire_date: Date,
    notice_date: Option<Date>,
    exit_date: Date,
    rules: &ExitClockRules,
) -> Result<bool, KernelError> {
    let service_end = exit_date.next_day().ok_or_else(out_of_range)?;
    let served = add_months(hire_date, rules.dismissal_notice_min_service_months)? <= service_end;
    let short = notice_date.is_none_or(|notice| {
        (exit_date - notice).whole_days() < i64::from(rules.dismissal_notice_days)
    });
    Ok(served && short)
}

/// A clock that starts on an event rather than on `exit_date`:
/// - request-triggered items, started by an attestation: 사용증명서 (근기법 §39,
///   즉시 = 0 days), 이직확인서 (고용보험법 §42③, register days [U]), an early
///   상실신고 on the worker's request (「지체 없이」);
/// - 퇴직일 미정: the report date plus the tenant's
///   `exit.date_unknown.resolve_days` setting.
///
/// # Errors
/// Validation when the due date leaves the supported calendar range.
pub fn due_after_days(start: Date, days: u16) -> Result<Date, KernelError> {
    start
        .checked_add(Duration::days(i64::from(days)))
        .ok_or_else(out_of_range)
}

/// W-21: a snooze may never move an inbox item past its legal due date.
/// Snoozing until the due date itself is allowed.
///
/// # Errors
/// Validation (→ 422) when `until` is after `due`.
pub fn check_snooze(until: Date, due: Date) -> Result<(), KernelError> {
    if until > due {
        return Err(KernelError::validation(
            "a snooze cannot move an item past its legal due date",
        ));
    }
    Ok(())
}

/// `date` plus whole calendar months; the day clamps to the target month's
/// last day (민법 §160③).
pub(crate) fn add_months(date: Date, months: u8) -> Result<Date, KernelError> {
    let month_index = u16::from(u8::from(date.month()) - 1) + u16::from(months);
    let year = date.year() + i32::from(month_index / 12);
    let month = date.month().nth_next(months);
    let day = date.day().min(month.length(year));
    Date::from_calendar_date(year, month, day).map_err(|_| out_of_range())
}

fn out_of_range() -> KernelError {
    KernelError::validation("exit clock date is outside the supported calendar range")
}
