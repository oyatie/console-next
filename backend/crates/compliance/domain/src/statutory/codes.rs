//! Statutory rule codes (BW-30).
//!
//! Each code names one legal number or unverified draft in `lifecycle_statutory_rules`. The number itself
//! lives only in the register row (migration-only, HOLD until reviewed); this
//! file names keys, never values. The core and draft tables' `code` CHECKs
//! together list the same set as [`ALL`].

/// Labor Standards Act §36: days from exit to pay every outstanding amount (final settlement).
pub const FINAL_PAY_DUE_DAYS: &str = "FINAL_PAY_DUE_DAYS";
/// Labor Standards Act §37① with Enforcement Decree §17: annual delay-interest
/// rate on unpaid wages.
pub const LATE_WAGE_INTEREST_ANNUAL_RATE: &str = "LATE_WAGE_INTEREST_ANNUAL_RATE";
/// Labor Standards Act §26: minimum dismissal-notice period.
pub const DISMISSAL_NOTICE_DAYS: &str = "DISMISSAL_NOTICE_DAYS";
/// Labor Standards Act §26 proviso: minimum continuous-service months for notice.
pub const DISMISSAL_NOTICE_MIN_SERVICE_MONTHS: &str = "DISMISSAL_NOTICE_MIN_SERVICE_MONTHS";
/// Labor Standards Act §2①6: months before the event that form the average-wage window.
pub const AVERAGE_WAGE_WINDOW_MONTHS: &str = "AVERAGE_WAGE_WINDOW_MONTHS";
/// Labor Standards Act §42: retention of the worker register and key contract records.
pub const EMPLOYMENT_RECORD_RETENTION_YEARS: &str = "EMPLOYMENT_RECORD_RETENTION_YEARS";
/// Labor Standards Act Enforcement Decree §19: how long after exit an
/// employment certificate may be requested.
pub const EMPLOYMENT_CERTIFICATE_REQUEST_YEARS: &str = "EMPLOYMENT_CERTIFICATE_REQUEST_YEARS";
/// Labor Standards Act Enforcement Decree §19: continuous service a worker
/// needs to request an employment certificate.
pub const EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS: &str = "EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS";
/// Employee Retirement Benefit Security Act §9①: days from exit to pay severance pay.
pub const SEVERANCE_PAY_DUE_DAYS: &str = "SEVERANCE_PAY_DUE_DAYS";
/// Employee Retirement Benefit Security Act §4①: minimum continuous service for severance pay.
pub const SEVERANCE_MIN_SERVICE_YEARS: &str = "SEVERANCE_MIN_SERVICE_YEARS";
/// Employee Retirement Benefit Security Act §4①: minimum 4-week-average weekly contract hours.
pub const SEVERANCE_MIN_WEEKLY_HOURS: &str = "SEVERANCE_MIN_WEEKLY_HOURS";
/// Employment Insurance Act Enforcement Decree §7①: loss report due on this
/// day of the following month.
pub const EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH: &str = "EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH";
/// National Pension Act Enforcement Rule §6①: loss report due on this day of
/// the following month.
pub const NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH: &str = "NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH";
/// National Health Insurance Act §9①3·②, §10② with Enforcement Rule §4①
/// proviso·④2: days from the day after the last working day to file the
/// employee-subscriber loss-of-eligibility report.
pub const NHIS_LOSS_REPORT_DUE_DAYS: &str = "NHIS_LOSS_REPORT_DUE_DAYS";
/// Employment Insurance Act Enforcement Rule §82-2②: days from a request to
/// issue the separation certificate.
pub const SEPARATION_CERTIFICATE_DUE_DAYS: &str = "SEPARATION_CERTIFICATE_DUE_DAYS";
/// Fixed-Term Workers Act §4①: the longest a fixed-term worker may be employed (BW-12).
pub const FIXED_TERM_MAX_YEARS: &str = "FIXED_TERM_MAX_YEARS";
/// Labor Standards Act §24③: days before a dismissal for managerial reasons
/// by which the workers' representative is told (LC-B3).
pub const MANAGERIAL_DISMISSAL_CONSULT_DAYS: &str = "MANAGERIAL_DISMISSAL_CONSULT_DAYS";
/// Labor Standards Act §28②: months after a dismissal within which an
/// application for remedy may be filed (LC-B3).
pub const UNFAIR_DISMISSAL_CLAIM_MONTHS: &str = "UNFAIR_DISMISSAL_CLAIM_MONTHS";

/// Labor Standards Act §23②: protection after work-injury or maternity leave.
pub const DISMISSAL_PROTECTION_TAIL_DAYS: &str = "DISMISSAL_PROTECTION_TAIL_DAYS";
/// Equal Employment Opportunity Act §19③: protection ends with childcare leave.
pub const CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS: &str = "CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS";

/// Labor Standards Act §50①: ordinary weekly working hours.
pub const WEEKLY_STANDARD_HOURS: &str = "WEEKLY_STANDARD_HOURS";
/// Labor Standards Act §53①: agreed weekly overtime limit.
pub const WEEKLY_OVERTIME_MAX_HOURS: &str = "WEEKLY_OVERTIME_MAX_HOURS";

/// Personal Information Protection Act Enforcement Decree §41④⑤: access response clock.
pub const PIPA_ACCESS_RESPONSE_DAYS: &str = "PIPA_ACCESS_RESPONSE_DAYS";
pub const PIPA_CORRECTION_RESPONSE_DAYS: &str = "PIPA_CORRECTION_RESPONSE_DAYS";
pub const PIPA_SUSPENSION_RESPONSE_DAYS: &str = "PIPA_SUSPENSION_RESPONSE_DAYS";

/// Every statutory rule code, in migration order.
pub const ALL: [&str; 48] = [
    DISMISSAL_PROTECTION_TAIL_DAYS,
    CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS,
    FINAL_PAY_DUE_DAYS,
    LATE_WAGE_INTEREST_ANNUAL_RATE,
    DISMISSAL_NOTICE_DAYS,
    DISMISSAL_NOTICE_MIN_SERVICE_MONTHS,
    AVERAGE_WAGE_WINDOW_MONTHS,
    EMPLOYMENT_RECORD_RETENTION_YEARS,
    EMPLOYMENT_CERTIFICATE_REQUEST_YEARS,
    EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS,
    SEVERANCE_PAY_DUE_DAYS,
    SEVERANCE_MIN_SERVICE_YEARS,
    SEVERANCE_MIN_WEEKLY_HOURS,
    EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH,
    NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH,
    NHIS_LOSS_REPORT_DUE_DAYS,
    SEPARATION_CERTIFICATE_DUE_DAYS,
    FIXED_TERM_MAX_YEARS,
    MANAGERIAL_DISMISSAL_CONSULT_DAYS,
    UNFAIR_DISMISSAL_CLAIM_MONTHS,
    "ins.deadline.acquire.nps",
    "ins.deadline.acquire.nhis",
    "ins.deadline.acquire.ei",
    "ins.deadline.acquire.iaci",
    "ins.deadline.lose.iaci",
    "ins.deadline.leave.ei",
    "ins.deadline.leave.iaci",
    "ins.filing.work_confirmation.ei",
    "ins.filing.work_confirmation.iaci",
    "ins.filing.age60.nps",
    "ins.filing.acquire_requested.ei",
    "ins.filing.monthly_remuneration.ei",
    "ins.filing.monthly_remuneration.iaci",
    "ins.deadline.leave.nps",
    "ins.deadline.leave.nhis",
    "ins.deadline.resume.nps",
    "ins.deadline.resume.nhis",
    "ins.deadline.resume.ei",
    "ins.deadline.resume.iaci",
    "ins.deadline.change.nps",
    "ins.deadline.change.nhis",
    "ins.deadline.change.ei",
    "ins.deadline.change.iaci",
    WEEKLY_STANDARD_HOURS,
    WEEKLY_OVERTIME_MAX_HOURS,
    PIPA_ACCESS_RESPONSE_DAYS,
    PIPA_CORRECTION_RESPONSE_DAYS,
    PIPA_SUSPENSION_RESPONSE_DAYS,
];

/// The statutory-filings deadline family (SF §3.1, `ins.deadline.<event>.<insurer>`)
/// that already has register rows, under their bw30 names. One key family, no
/// parallel codes: a template names the SF key and the register answers it from
/// the row below until SF mints the rest of the family.
pub const INS_DEADLINE_ALIASES: [(&str, &str); 3] = [
    ("ins.deadline.lose.ei", EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH),
    (
        "ins.deadline.lose.nps",
        NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH,
    ),
    ("ins.deadline.lose.nhis", NHIS_LOSS_REPORT_DUE_DAYS),
];

/// The register code a key resolves to: an `ins.deadline.*` alias, else itself.
#[must_use]
pub fn resolve(key: &str) -> &str {
    INS_DEADLINE_ALIASES
        .iter()
        .find(|(alias, _)| *alias == key)
        .map_or(key, |(_, code)| code)
}
