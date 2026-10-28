//! Statutory rule codes (BW-30).
//!
//! Each code names one legal number or unverified draft in `lifecycle_statutory_rules`. The number itself
//! lives only in the register row (migration-only, HOLD until reviewed); this
//! file names keys, never values. The core and draft tables' `code` CHECKs
//! together list the same set as [`ALL`].

/// 근로기준법 §36: days from exit to pay every outstanding amount (금품청산).
pub const FINAL_PAY_DUE_DAYS: &str = "FINAL_PAY_DUE_DAYS";
/// 근로기준법 §37① with 시행령 §17: annual delay-interest rate on unpaid wages.
pub const LATE_WAGE_INTEREST_ANNUAL_RATE: &str = "LATE_WAGE_INTEREST_ANNUAL_RATE";
/// 근로기준법 §26: minimum dismissal-notice period.
pub const DISMISSAL_NOTICE_DAYS: &str = "DISMISSAL_NOTICE_DAYS";
/// 근로기준법 §26 단서: minimum continuous-service months for notice.
pub const DISMISSAL_NOTICE_MIN_SERVICE_MONTHS: &str = "DISMISSAL_NOTICE_MIN_SERVICE_MONTHS";
/// 근로기준법 §2①6: months before the event that form the average-wage window.
pub const AVERAGE_WAGE_WINDOW_MONTHS: &str = "AVERAGE_WAGE_WINDOW_MONTHS";
/// 근로기준법 §42: retention of the worker register and key contract records.
pub const EMPLOYMENT_RECORD_RETENTION_YEARS: &str = "EMPLOYMENT_RECORD_RETENTION_YEARS";
/// 근로기준법 시행령 §19: how long after exit a 사용증명서 may be requested.
pub const EMPLOYMENT_CERTIFICATE_REQUEST_YEARS: &str = "EMPLOYMENT_CERTIFICATE_REQUEST_YEARS";
/// 근로기준법 시행령 §19: continuous service a worker needs to request a 사용증명서.
pub const EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS: &str = "EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS";
/// 근로자퇴직급여 보장법 §9①: days from exit to pay 퇴직금.
pub const SEVERANCE_PAY_DUE_DAYS: &str = "SEVERANCE_PAY_DUE_DAYS";
/// 근로자퇴직급여 보장법 §4①: minimum continuous service for 퇴직금.
pub const SEVERANCE_MIN_SERVICE_YEARS: &str = "SEVERANCE_MIN_SERVICE_YEARS";
/// 근로자퇴직급여 보장법 §4①: minimum 4-week-average weekly contract hours.
pub const SEVERANCE_MIN_WEEKLY_HOURS: &str = "SEVERANCE_MIN_WEEKLY_HOURS";
/// 고용보험법 시행령 §7①: 상실신고 due on this day of the following month.
pub const EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH: &str = "EI_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH";
/// 국민연금법 시행규칙 §6①: 상실신고 due on this day of the following month.
pub const NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH: &str = "NPS_LOSS_REPORT_DUE_DAY_OF_NEXT_MONTH";
/// 국민건강보험법 §9①3·②, §10② with 시행규칙 §4① 단서·④2: days from the
/// day after the last working day to file the 직장가입자 자격상실 신고.
pub const NHIS_LOSS_REPORT_DUE_DAYS: &str = "NHIS_LOSS_REPORT_DUE_DAYS";
/// 고용보험법 시행규칙 §82의2②: days from a request to issue the 이직확인서.
pub const SEPARATION_CERTIFICATE_DUE_DAYS: &str = "SEPARATION_CERTIFICATE_DUE_DAYS";
/// 기간제법 §4①: the longest a fixed-term worker may be employed (BW-12).
pub const FIXED_TERM_MAX_YEARS: &str = "FIXED_TERM_MAX_YEARS";
/// 근로기준법 §24③: days before a 경영상 해고 by which the 근로자대표 is told (LC-B3).
pub const MANAGERIAL_DISMISSAL_CONSULT_DAYS: &str = "MANAGERIAL_DISMISSAL_CONSULT_DAYS";
/// 근로기준법 §28②: months after a dismissal within which 구제신청 may be filed (LC-B3).
pub const UNFAIR_DISMISSAL_CLAIM_MONTHS: &str = "UNFAIR_DISMISSAL_CLAIM_MONTHS";

/// 근로기준법 §23②: protection after work-injury or maternity leave.
pub const DISMISSAL_PROTECTION_TAIL_DAYS: &str = "DISMISSAL_PROTECTION_TAIL_DAYS";
/// 남녀고용평등법 §19③: protection ends with childcare leave.
pub const CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS: &str = "CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS";

/// 근로기준법 §50①: ordinary weekly working hours.
pub const WEEKLY_STANDARD_HOURS: &str = "WEEKLY_STANDARD_HOURS";
/// 근로기준법 §53①: agreed weekly overtime limit.
pub const WEEKLY_OVERTIME_MAX_HOURS: &str = "WEEKLY_OVERTIME_MAX_HOURS";

/// 개인정보 보호법 시행령 §41④⑤: access response clock.
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
