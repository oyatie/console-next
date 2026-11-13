// SPDX-License-Identifier: LicenseRef-Proprietary
use time::Date;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeverancePayInput {
    /// Start of the unpaid severance accrual period.
    pub hire_date: Date,
    /// Continuous service start used for statutory eligibility.
    pub service_start_date: Date,
    pub exit_date: Date,
    pub average_wage_period_start: Date,
    pub average_wage_period_end: Date,
    pub average_wage_calendar_days: i64,
    pub average_wage_total_won: i64,
    /// 1-day ordinary wage in won.
    ///
    /// MANDATORY (not `Option`) by design: Labor Standards Act Enforcement Decree
    /// Article 2(2) requires
    /// severance to use the HIGHER of the average wage and the ordinary wage, so
    /// every caller must supply this. A plain field makes omission a *compile*
    /// error rather than a silent average-wage-only fall back — which is exactly
    /// the under-calculation bug that hurts the absence→exit population whose
    /// depressed 3-month window yields an artificially low average wage. The
    /// caller is responsible for deriving this daily figure from the monthly
    /// ordinary wage (e.g. via the 209h standard-hours rule); the kernel keeps
    /// that policy out.
    /// A payable draft rejects a non-positive value in `build_severance_pay_draft`.
    pub ordinary_daily_wage_won: i64,
}
