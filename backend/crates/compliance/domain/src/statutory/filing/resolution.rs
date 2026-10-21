use super::{Applicability, FilingAnchors, FilingFacts, FilingRule, Reason};
use console_kernel_core::KernelError;
use time::Date;

pub fn state(action: Option<&str>, applies: &Applicability, covered: bool) -> &'static str {
    match action {
        Some("COMPLETE") => "DONE",
        Some("NOT_APPLICABLE") => "NOT_APPLICABLE",
        _ if covered => "COVERED",
        _ if matches!(applies, Applicability::NotApplicable { .. }) => "NOT_APPLICABLE",
        _ => "PENDING",
    }
}
fn reason_matches(reason: Reason, exclusion: &super::Exclusion) -> bool {
    use super::Exclusion;
    matches!(
        (reason, exclusion),
        (Reason::AgeLimit, Exclusion::AgeLimit { .. })
            | (Reason::MinorOptOut, Exclusion::MinorOptOut { .. })
            | (
                Reason::ShortHours,
                Exclusion::ShortHours { .. } | Exclusion::Income { .. }
            )
            | (
                Reason::DailyUnderMonth,
                Exclusion::Daily {
                    work_confirmation: false,
                    ..
                }
            )
            | (
                Reason::DailyWorkConfirmation,
                Exclusion::Daily {
                    work_confirmation: true,
                    ..
                }
            )
            | (Reason::TreatyExcluded, Exclusion::ForeignTreaty)
            | (Reason::VisaExcluded, Exclusion::ForeignVisa)
            | (Reason::ExecutiveNotWorker, Exclusion::ExecutiveNotWorker)
    )
}
pub fn reason_allowed(reason: Reason, rule: &FilingRule) -> bool {
    reason == Reason::OtherLegalGround || rule.exclusions.iter().any(|r| reason_matches(reason, r))
}
pub fn validate_not_applicable(
    rule: &FilingRule,
    anchors: &FilingAnchors,
    facts: &FilingFacts,
    reason: Reason,
) -> Result<(), KernelError> {
    let invalid = |m| KernelError::validation(m).with_code("filing_not_applicable_invalid");
    if !reason_allowed(reason, rule) {
        return Err(invalid(
            "Choose a not-applicable ground cited for this insurer and date.",
        ));
    }
    if reason == Reason::OtherLegalGround {
        return Ok(());
    }
    let mut focused = rule.clone();
    focused.exclusions.retain(|r| reason_matches(reason, r));
    focused.daily_required = false;
    if matches!(
        super::applies(&focused, anchors, facts)?,
        Applicability::Applies
    ) {
        return Err(invalid(
            "This not-applicable ground contradicts the known facts; confirm the facts or choose another cited ground.",
        ));
    }
    Ok(())
}
/// A claimed exemption must be an allowed cited ground; actual filing waits for its opening.
pub fn validate_completion(
    rule: &FilingRule,
    anchors: &FilingAnchors,
    facts: &FilingFacts,
    completed: Date,
    opens: Date,
    remuneration: Option<i64>,
) -> Result<(), KernelError> {
    let invalid = |m| KernelError::validation(m).with_code("filing_record_invalid");
    if completed < opens {
        return Err(invalid(
            "The filing date precedes the opening; choose the actual filing date.",
        ));
    }
    if rule.remuneration_required && remuneration.is_none() {
        return Err(KernelError::validation(
            "Enter the reported total remuneration with the loss filing.",
        )
        .with_code("filing_remuneration_required"));
    }
    if !matches!(
        super::applicability::applies(rule, anchors, facts)?,
        Applicability::Applies
    ) {
        return Err(KernelError::validation(
            "Confirm the applicability facts, or record a cited not-applicable ground.",
        )
        .with_code("filing_applicability_unverified"));
    }
    Ok(())
}
pub fn reasons(rule: &FilingRule) -> Vec<Reason> {
    [
        Reason::AgeLimit,
        Reason::MinorOptOut,
        Reason::ShortHours,
        Reason::DailyUnderMonth,
        Reason::DailyWorkConfirmation,
        Reason::TreatyExcluded,
        Reason::VisaExcluded,
        Reason::ExecutiveNotWorker,
        Reason::OtherLegalGround,
    ]
    .into_iter()
    .filter(|r| reason_allowed(*r, rule))
    .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolutions_do_not_turn_assessment_or_coverage_into_a_filing_date() {
        assert_eq!(
            state(Some("ASSESS"), &Applicability::Applies, false),
            "PENDING"
        );
        assert_eq!(state(None, &Applicability::Applies, true), "COVERED");
        assert_eq!(
            state(
                None,
                &Applicability::NotApplicable {
                    reason: Reason::AgeLimit
                },
                false
            ),
            "NOT_APPLICABLE"
        );
        assert_eq!(
            state(Some("COMPLETE"), &Applicability::Applies, false),
            "DONE"
        );
    }
}
