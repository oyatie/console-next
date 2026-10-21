#![allow(clippy::unwrap_used)]
use super::{
    tests::{ordinary, rule},
    *,
};
use time::{Date, macros::date};

#[test]
fn applicability_facts_reject_impossible_calendar_totals_and_negative_income() {
    for f in [
        FilingFacts {
            birth_date: Some("2023-02-29".into()),
            ..FilingFacts::default()
        },
        FilingFacts {
            monthly_hours: Some(745),
            ..FilingFacts::default()
        },
        FilingFacts {
            weekly_hours: Some(169),
            ..FilingFacts::default()
        },
        FilingFacts {
            work_days: Some(32),
            ..FilingFacts::default()
        },
        FilingFacts {
            worked_monthly_hours: Some(745),
            ..FilingFacts::default()
        },
        FilingFacts {
            monthly_income_won: Some(-1),
            ..FilingFacts::default()
        },
    ] {
        assert!(f.validate().is_err());
    }
    for income in [0, 1, i64::MAX] {
        assert!(
            FilingFacts {
                monthly_hours: Some(744),
                weekly_hours: Some(168),
                work_days: Some(31),
                worked_monthly_hours: Some(744),
                monthly_income_won: Some(income),
                ..FilingFacts::default()
            }
            .validate()
            .is_ok()
        );
    }
}

#[test]
fn rule_metadata_rejects_invalid_intervals_citations_and_clock_values() {
    for change in 0..6 {
        let mut r = rule("NPS", "ACQUIRE");
        match change {
            0 => r.effective_to_exclusive = Some(r.effective_from.clone()),
            1 => r.citation.enforced_on = "2099-01-01".into(),
            2 => r.citation.source_url = "https://example.invalid/law".into(),
            3 => {
                r.deadline = Calculation {
                    anchor: FilingAnchor::AcquireDate,
                    kind: FilingRuleKind::Days,
                    value: Some(0),
                    first_day: FirstDay::Excluded,
                }
            }
            4 => r.deadline.value = Some(0),
            _ => r.deadline.value = Some(29),
        }
        assert!(r.validate().is_err());
    }
    let mut r = rule("NPS", "LOSE");
    r.loss_offset_days = 1;
    assert_eq!(
        r.loss_on(date!(2024 - 02 - 29)).unwrap(),
        date!(2024 - 03 - 01)
    );
    assert!(r.loss_on(Date::MAX).is_err());
}

#[test]
fn actual_completion_requires_an_open_window_applicability_and_required_remuneration() {
    let mut r = rule("NPS", "ACQUIRE");
    let on = date!(2026 - 10 - 12);
    let a = FilingAnchors {
        acquire_date: Some(on),
        effective_date: Some(on),
        ..FilingAnchors::default()
    };
    let f = ordinary();
    let call = |r: &FilingRule, f: &FilingFacts, date, amount| {
        resolution::validate_completion(r, &a, f, date, on, amount)
    };
    assert!(call(&r, &f, on, None).is_ok());
    assert!(call(&r, &f, date!(2026 - 10 - 11), None).is_err());
    assert_eq!(
        call(&r, &FilingFacts::default(), on, None)
            .unwrap_err()
            .code,
        Some("filing_applicability_unverified")
    );
    assert!(
        call(
            &r,
            &FilingFacts {
                birth_date: Some("1960-01-01".into()),
                ..f.clone()
            },
            on,
            None
        )
        .is_err()
    );
    r.remuneration_required = true;
    assert_eq!(
        call(&r, &f, on, None).unwrap_err().code,
        Some("filing_remuneration_required")
    );
    assert!(call(&r, &f, on, Some(0)).is_ok());
    assert_eq!(
        resolution::state(Some("NOT_APPLICABLE"), &Applicability::Applies, false),
        "NOT_APPLICABLE"
    );
    assert_eq!(
        resolution::reasons(&r),
        vec![
            Reason::AgeLimit,
            Reason::MinorOptOut,
            Reason::ShortHours,
            Reason::DailyUnderMonth,
            Reason::TreatyExcluded,
            Reason::OtherLegalGround
        ]
    );
}

#[test]
fn monthly_and_weekly_short_hours_are_independent_and_thresholds_are_inclusive() {
    let mut f = ordinary();
    f.continuous_months = Some(1);
    for (monthly, weekly, excluded) in [(60, 15, false), (59, 15, true), (60, 14, true)] {
        f.monthly_hours = Some(monthly);
        f.weekly_hours = Some(weekly);
        assert_eq!(
            matches!(
                applicability(&rule("EI", "ACQUIRE").exclusions, &f, date!(2026 - 10 - 12))
                    .unwrap(),
                Applicability::NotApplicable {
                    reason: Reason::ShortHours
                }
            ),
            excluded
        );
    }
    let daily = FilingFacts {
        daily: Some(true),
        monthly_hours: Some(10),
        weekly_hours: Some(5),
        ..ordinary()
    };
    assert_eq!(
        applicability(
            &rule("EI", "ACQUIRE").exclusions,
            &daily,
            date!(2026 - 10 - 12)
        )
        .unwrap(),
        Applicability::NotApplicable {
            reason: Reason::DailyWorkConfirmation
        }
    );
    f.monthly_hours = Some(60);
    assert_eq!(
        applicability(
            &rule("NHIS", "ACQUIRE").exclusions,
            &f,
            date!(2026 - 10 - 12)
        )
        .unwrap(),
        Applicability::Applies
    );
    f.foreign = Some(true);
    f.treaty = Some(Treaty::Covered);
    f.monthly_hours = Some(160);
    assert_eq!(
        applicability(
            &rule("NPS", "ACQUIRE").exclusions,
            &f,
            date!(2026 - 10 - 12)
        )
        .unwrap(),
        Applicability::Applies
    );
    for visa in [VisaCoverage::Mandatory, VisaCoverage::OptedIn] {
        f.visa = Some(visa);
        f.weekly_hours = Some(40);
        assert_eq!(
            applicability(&rule("EI", "ACQUIRE").exclusions, &f, date!(2026 - 10 - 12)).unwrap(),
            Applicability::Applies
        );
    }
    assert!(
        dates(
            &rule("NPS", "ACQUIRE"),
            &FilingAnchors {
                acquire_date: Some(date!(2026 - 10 - 12)),
                ..FilingAnchors::default()
            },
            &[]
        )
        .unwrap()
        .holiday_roll_unverified
    );
}

#[test]
fn pension_daily_construction_work_cannot_use_the_general_workplace_hour_exception() {
    let f = FilingFacts {
        daily: Some(true),
        work_days: Some(7),
        worked_monthly_hours: Some(80),
        income_exception_covered: Some(false),
        pension_daily_sector: Some(PensionDailySector::ConstructionNotice),
        ..ordinary()
    };
    assert_eq!(
        applicability(
            &rule("NPS", "ACQUIRE").exclusions,
            &f,
            date!(2026 - 10 - 12)
        )
        .unwrap(),
        Applicability::NotApplicable {
            reason: Reason::DailyUnderMonth
        }
    );
}

#[test]
fn income_rules_use_the_registered_amount_only_after_exceptions_are_known() {
    let exclusions = [Exclusion::Income {
        threshold_won: Some(100),
        continuous_months_exception: 3,
    }];
    for (income, excluded) in [(99, true), (100, false), (101, false)] {
        let f = FilingFacts {
            monthly_income_won: Some(income),
            multiple_jobs_covered: Some(false),
            ..ordinary()
        };
        assert_eq!(
            matches!(
                applicability(&exclusions, &f, date!(2027 - 01 - 01)).unwrap(),
                Applicability::NotApplicable { .. }
            ),
            excluded
        );
    }
    let f = FilingFacts {
        monthly_income_won: Some(1),
        multiple_jobs_covered: Some(true),
        ..ordinary()
    };
    assert_eq!(
        applicability(&exclusions, &f, date!(2027 - 01 - 01)).unwrap(),
        Applicability::Applies
    );
}
