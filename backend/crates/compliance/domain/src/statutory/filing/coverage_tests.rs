#![allow(clippy::unwrap_used)]
use super::{
    tests::{ordinary, rule},
    *,
};
use time::macros::date;
fn status(insurer: &str, facts: FilingFacts) -> Applicability {
    applicability(
        &rule(insurer, "ACQUIRE").exclusions,
        &facts,
        date!(2026 - 10 - 12),
    )
    .unwrap()
}
#[test]
fn unverified_short_hours_exceptions_never_become_false_exclusions() {
    for insurer in ["EI", "NPS"] {
        let facts = FilingFacts {
            monthly_hours: Some(10),
            weekly_hours: Some(5),
            continuous_months: None,
            ..ordinary()
        };
        assert!(matches!(
            status(insurer, facts),
            Applicability::Unknown { .. }
        ));
    }
    let known = FilingFacts {
        monthly_hours: Some(10),
        weekly_hours: Some(5),
        pension_opt_in: Some(false),
        pension_lecturer_covered: Some(false),
        multiple_jobs_covered: Some(false),
        income_exception_covered: Some(false),
        ..ordinary()
    };
    for insurer in ["EI", "NPS"] {
        assert_eq!(
            status(insurer, known.clone()),
            Applicability::NotApplicable {
                reason: Reason::ShortHours
            }
        );
    }
    assert_eq!(
        status(
            "EI",
            FilingFacts {
                continuous_months: Some(3),
                ..known.clone()
            }
        ),
        Applicability::Applies
    );
    assert_eq!(
        status(
            "NPS",
            FilingFacts {
                pension_opt_in: Some(true),
                ..known
            }
        ),
        Applicability::Applies
    );
}
#[test]
fn pension_daily_coverage_uses_actual_days_hours_income_instead_of_scheduled_hours() {
    let daily = FilingFacts {
        daily: Some(true),
        monthly_hours: Some(20),
        work_days: Some(8),
        ..ordinary()
    };
    assert_eq!(status("NPS", daily.clone()), Applicability::Applies);
    assert_eq!(
        status(
            "NPS",
            FilingFacts {
                work_days: Some(7),
                worked_monthly_hours: Some(60),
                pension_daily_sector: Some(PensionDailySector::General),
                ..daily.clone()
            }
        ),
        Applicability::Applies
    );
    assert!(matches!(
        status(
            "NPS",
            FilingFacts {
                work_days: Some(7),
                monthly_hours: Some(160),
                ..daily.clone()
            }
        ),
        Applicability::Unknown { .. }
    ));
    assert_eq!(
        status(
            "NPS",
            FilingFacts {
                work_days: Some(7),
                worked_monthly_hours: Some(59),
                income_exception_covered: Some(false),
                ..daily.clone()
            }
        ),
        Applicability::NotApplicable {
            reason: Reason::DailyUnderMonth
        }
    );
    assert_eq!(
        status(
            "NPS",
            FilingFacts {
                continuous_months: Some(0),
                ..daily
            }
        ),
        Applicability::NotApplicable {
            reason: Reason::DailyUnderMonth
        }
    );
}
#[test]
fn daily_substitution_ground_is_only_offered_for_insurers_with_that_policy() {
    for insurer in ["NPS", "NHIS"] {
        let r = rule(insurer, "ACQUIRE");
        assert!(!resolution::reason_allowed(
            Reason::DailyWorkConfirmation,
            &r
        ));
        assert!(resolution::reason_allowed(Reason::DailyUnderMonth, &r));
    }
    for insurer in ["EI", "IACI"] {
        let r = rule(insurer, "ACQUIRE");
        assert!(resolution::reason_allowed(
            Reason::DailyWorkConfirmation,
            &r
        ));
        assert!(!resolution::reason_allowed(Reason::DailyUnderMonth, &r));
    }
}
#[test]
fn age_limit_clips_leap_day_anniversary_and_keeps_the_day_before_eligible() {
    let r = [Exclusion::AgeLimit { years: 60 }];
    let f = FilingFacts {
        birth_date: Some("2000-02-29".into()),
        ..ordinary()
    };
    assert_eq!(
        applicability(&r, &f, date!(2060 - 02 - 28)).unwrap(),
        Applicability::Applies
    );
    assert_eq!(
        applicability(&r, &f, date!(2060 - 02 - 29)).unwrap(),
        Applicability::NotApplicable {
            reason: Reason::AgeLimit
        }
    );
    let r = [Exclusion::AgeLimit { years: 61 }];
    assert_eq!(
        applicability(&r, &f, date!(2061 - 02 - 28)).unwrap(),
        Applicability::NotApplicable {
            reason: Reason::AgeLimit
        }
    );
}

#[test]
fn manual_typed_grounds_reject_known_contradictions_and_keep_unknown_edge_evidence() {
    let r = rule("NPS", "ACQUIRE");
    let on = date!(2026 - 10 - 12);
    let a = FilingAnchors {
        acquire_date: Some(on),
        effective_date: Some(on),
        ..FilingAnchors::default()
    };
    assert_eq!(
        resolution::validate_not_applicable(&r, &a, &ordinary(), Reason::AgeLimit)
            .err()
            .and_then(|e| e.code),
        Some("filing_not_applicable_invalid")
    );
    assert!(
        resolution::validate_not_applicable(&r, &a, &FilingFacts::default(), Reason::AgeLimit)
            .is_ok()
    );
    assert!(
        resolution::validate_not_applicable(&r, &a, &ordinary(), Reason::OtherLegalGround).is_ok()
    );
}

#[test]
fn filing_register_rejects_ambiguous_duties_and_resolves_adjacent_slices_and_aliases() {
    use crate::statutory::StatutoryRegister;
    let r = rule("NPS", "LOSE");
    let empty = || StatutoryRegister::new(vec![], vec![]).unwrap();
    assert!(
        empty()
            .with_filing_rules(vec![r.clone(), r.clone()])
            .is_err()
    );
    let mut collision = rule("EI", "ACQUIRE");
    collision.code = r.code.clone();
    assert!(
        empty()
            .with_filing_rules(vec![r.clone(), collision])
            .is_err()
    );
    let mut other = r.clone();
    other.code = "another-code-for-the-same-duty".into();
    assert!(empty().with_filing_rules(vec![r.clone(), other]).is_err());
    let mut before = r.clone();
    before.effective_to_exclusive = Some("2026-04-01".into());
    let mut after = r.clone();
    after.effective_from = "2026-04-01".into();
    assert!(
        empty()
            .with_filing_rules(vec![after.clone(), before.clone()])
            .is_ok()
    );
    let mut later = after.clone();
    later.effective_from = "2026-06-01".into();
    assert!(
        empty()
            .with_filing_rules(vec![later, before.clone()])
            .is_ok()
    );
    let mut overlapping = before.clone();
    overlapping.effective_to_exclusive = Some("2026-05-01".into());
    assert!(
        empty()
            .with_filing_rules(vec![overlapping.clone(), after.clone()])
            .is_err()
    );
    assert!(
        empty()
            .with_filing_rules(vec![after.clone(), overlapping])
            .is_err()
    );
    assert!(
        empty()
            .with_filing_rules(vec![
                r.clone(),
                rule("NPS", "ACQUIRE"),
                rule("EI", "LOSE"),
                rule("IACI", "ACQUIRE")
            ])
            .is_ok()
    );
    let register = empty().with_filing_rules(vec![before, after]).unwrap();
    assert_eq!(
        register
            .filing_rule("NPS", "LOSE", date!(2026 - 03 - 01))
            .unwrap()
            .unwrap()
            .effective_from,
        "2026-02-13"
    );
    assert!(
        register
            .filing_rule("NHIS", "LOSE", date!(2026 - 03 - 01))
            .unwrap()
            .is_none()
    );
    assert!(
        register
            .filing_rule("NPS", "ACQUIRE", date!(2026 - 03 - 01))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        register.first_filing_date("NPS", "LOSE").unwrap(),
        Some(date!(2026 - 02 - 13))
    );
    assert_eq!(register.first_filing_date("NHIS", "LOSE").unwrap(), None);
    assert!(
        register
            .filing_rule("NPS", "LOSE", date!(2026 - 02 - 12))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        register
            .filing_rule_by_code("ins.deadline.lose.nps", date!(2026 - 04 - 01))
            .unwrap()
            .unwrap()
            .effective_from,
        "2026-04-01"
    );
}
