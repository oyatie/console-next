//! An exit case's settlement deadlines (금품청산 and 퇴직금): the windows of
//! `console_hr_domain::exits::settlement_due` over the statutory register,
//! with the citation each deadline rests on. Served on the case read.

use console_compliance_domain::statutory::StatutoryRegister;
use console_hr_domain::cases::clocks::Clock;
use console_hr_domain::exits::settlement_due::settlement_windows;
use console_hr_domain::text::parse_yyyy_mm_dd;

use crate::HrError;
use crate::cases::register::Register;
use crate::clock::today_kst;
use crate::exits::types::ExitSettlementDeadline;

/// The deadlines of an exit whose 마지막 근무일 is `exit_date`.
///
/// # Errors
/// 422 when the stored date is not a date.
pub(crate) fn settlement_deadlines(
    exit_date: &str,
    register: &StatutoryRegister,
) -> Result<Vec<ExitSettlementDeadline>, HrError> {
    let exit = parse_yyyy_mm_dd(exit_date)?;
    let today = today_kst();
    Ok(settlement_windows(exit, &Register(register.clone()))
        .into_iter()
        .map(|w| {
            let code = w.due.register_code();
            let citation = register.rule(code, exit).ok().map(|r| r.citation.clone());
            let (due_date, due_in_days, status) = match w.clock {
                Clock::Due { date, held } => (
                    Some(date.to_string()),
                    Some((date - today).whole_days()),
                    if held { "HOLD" } else { "RELEASED" },
                ),
                _ => (None, None, "UNKNOWN"),
            };
            ExitSettlementDeadline {
                kind: w.due.as_str(),
                opens_on: w.opens_on.map(|d| d.to_string()),
                due_date,
                due_in_days,
                deadline_status: status,
                instrument: citation.as_ref().map(|c| c.instrument_ko.clone()),
                // The register keeps the article with its quoted text; the
                // deadline names the article itself.
                article: citation
                    .and_then(|c| c.article_ko.split_whitespace().next().map(str::to_owned)),
            }
        })
        .collect())
}
