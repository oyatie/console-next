#![allow(clippy::unwrap_used, clippy::panic)]
use super::*;
use time::{Date, Month, macros::date};
fn rows() -> Vec<FilingRule> {
    include_str!(
        "../../../../../platform/db/migrations/20261013111137534_statutory_filing_rules.sql"
    )
    .lines()
    .filter_map(|line| {
        let start = line.find("'{\"code\"")? + 1;
        let end = line.rfind("'::jsonb")?;
        Some(serde_json::from_str(&line[start..end]).unwrap())
    })
    .collect()
}
pub(super) fn rule(insurer: &str, kind: &str) -> FilingRule {
    rows()
        .into_iter()
        .find(|r| {
            r.insurer == insurer
                && r.filing_kind == kind
                && r.in_force(date!(2026 - 10 - 12)).unwrap()
        })
        .unwrap()
}
fn anchors(on: Date) -> FilingAnchors {
    FilingAnchors {
        effective_date: Some(on),
        acquire_date: Some(on),
        exit_date: Some(on),
        loss_date: on.next_day(),
        request_date: Some(on),
        work_month: Some(on),
    }
}
#[test]
fn every_register_slice_handles_month_ends_leap_years_first_and_last_day() {
    let rows = rows();
    assert!(!rows.is_empty());
    for r in rows {
        r.validate().unwrap();
        for year in [2024, 2026, 2027] {
            for month in 1..=12 {
                let month = Month::try_from(month).unwrap();
                for day in [1, month.length(year)] {
                    let on = Date::from_calendar_date(year, month, day).unwrap();
                    let d = dates(&r, &anchors(on), &[]).unwrap();
                    assert_eq!(d.target_on, d.opens_on);
                    if let Some(due) = d.due_on {
                        assert!(due >= on.to_string(), "{}", r.code);
                    }
                    if let Some(candidate) = d.legal_latest_candidate {
                        assert!(Some(candidate) >= dates(&r, &anchors(on), &[]).unwrap().due_on);
                    }
                }
            }
        }
    }
}
#[test]
fn health_clocks_share_the_conservative_first_day_and_keep_the_legal_candidate() {
    let hire = dates(
        &rule("NHIS", "ACQUIRE"),
        &anchors(date!(2026 - 09 - 01)),
        &[],
    )
    .unwrap();
    assert_eq!(hire.due_on.as_deref(), Some("2026-09-14"));
    assert_eq!(hire.legal_latest_candidate.as_deref(), Some("2026-09-15"));
    let exit = dates(&rule("NHIS", "LOSE"), &anchors(date!(2026 - 09 - 30)), &[]).unwrap();
    assert_eq!(exit.opens_on, "2026-10-01");
    assert_eq!(exit.due_on.as_deref(), Some("2026-10-14"));
    assert_eq!(exit.legal_latest_candidate.as_deref(), Some("2026-10-15"));
    for insurer in ["NPS", "EI", "IACI"] {
        let d = dates(&rule(insurer, "LOSE"), &anchors(date!(2026 - 09 - 30)), &[]).unwrap();
        assert_eq!(d.due_on.as_deref(), Some("2026-10-15"));
        assert_eq!(d.legal_latest_candidate.as_deref(), Some("2026-11-15"));
    }
}
#[test]
fn requests_use_request_day_and_without_delay_never_invents_a_deadline() {
    let mut a = anchors(date!(2026 - 09 - 30));
    a.request_date = Some(date!(2026 - 10 - 12));
    assert_eq!(
        dates(&rule("EI", "SEPARATION_CERTIFICATE"), &a, &[])
            .unwrap()
            .due_on
            .as_deref(),
        Some("2026-10-22")
    );
    let d = dates(&rule("EI", "ACQUIRE_REQUESTED"), &a, &[]).unwrap();
    assert!(d.without_delay);
    assert!(d.due_on.is_none());
    assert_eq!(d.target_on, "2026-10-12");
    let mut r = rule("NHIS", "LOSE");
    r.holiday_roll = HolidayRoll::CivilCode161;
    assert_eq!(
        dates(
            &r,
            &anchors(date!(2026 - 10 - 03)),
            &[date!(2026 - 10 - 19)]
        )
        .unwrap()
        .due_on
        .as_deref(),
        Some("2026-10-20")
    );
}
pub(super) fn ordinary() -> FilingFacts {
    FilingFacts {
        birth_date: Some("1990-01-01".into()),
        monthly_hours: Some(160),
        weekly_hours: Some(40),
        continuous_months: Some(1),
        daily: Some(false),
        foreign: Some(false),
        director_without_worker_status: Some(false),
        ..FilingFacts::default()
    }
}
#[test]
fn lawful_exclusions_are_typed_and_missing_facts_are_unknown() {
    for (insurer, reason, facts) in [
        (
            "NPS",
            Reason::AgeLimit,
            FilingFacts {
                birth_date: Some("1966-10-12".into()),
                ..ordinary()
            },
        ),
        (
            "NPS",
            Reason::MinorOptOut,
            FilingFacts {
                birth_date: Some("2010-10-12".into()),
                minor_opt_out: Some(true),
                ..ordinary()
            },
        ),
        (
            "NHIS",
            Reason::ShortHours,
            FilingFacts {
                monthly_hours: Some(59),
                ..ordinary()
            },
        ),
        (
            "NHIS",
            Reason::DailyUnderMonth,
            FilingFacts {
                daily: Some(true),
                continuous_months: Some(0),
                ..ordinary()
            },
        ),
        (
            "EI",
            Reason::DailyWorkConfirmation,
            FilingFacts {
                daily: Some(true),
                ..ordinary()
            },
        ),
        (
            "NPS",
            Reason::TreatyExcluded,
            FilingFacts {
                foreign: Some(true),
                treaty: Some(Treaty::Excluded),
                ..ordinary()
            },
        ),
        (
            "EI",
            Reason::VisaExcluded,
            FilingFacts {
                foreign: Some(true),
                visa: Some(VisaCoverage::OptionalNotOptedIn),
                ..ordinary()
            },
        ),
        (
            "IACI",
            Reason::ExecutiveNotWorker,
            FilingFacts {
                director_without_worker_status: Some(true),
                ..ordinary()
            },
        ),
    ] {
        assert_eq!(
            applicability(
                &rule(insurer, "ACQUIRE").exclusions,
                &facts,
                date!(2026 - 10 - 12)
            )
            .unwrap(),
            Applicability::NotApplicable { reason }
        );
    }
    for insurer in ["NPS", "NHIS", "EI", "IACI"] {
        assert_eq!(
            applicability(
                &rule(insurer, "ACQUIRE").exclusions,
                &ordinary(),
                date!(2026 - 10 - 12)
            )
            .unwrap(),
            Applicability::Applies
        );
        assert!(matches!(
            applicability(
                &rule(insurer, "ACQUIRE").exclusions,
                &FilingFacts::default(),
                date!(2026 - 10 - 12)
            )
            .unwrap(),
            Applicability::Unknown { .. }
        ));
    }
    let mut f = ordinary();
    f.daily = Some(true);
    f.continuous_months = Some(1);
    assert_eq!(
        applicability(
            &rule("NHIS", "ACQUIRE").exclusions,
            &f,
            date!(2026 - 10 - 12)
        )
        .unwrap(),
        Applicability::Applies
    );
    f.continuous_months = Some(3);
    f.monthly_hours = Some(10);
    assert_eq!(
        applicability(&rule("EI", "ACQUIRE").exclusions, &f, date!(2026 - 10 - 12)).unwrap(),
        Applicability::NotApplicable {
            reason: Reason::DailyWorkConfirmation
        }
    );
}
#[test]
fn future_income_threshold_stays_unknown_and_citations_select_the_in_force_slice() {
    let rows = rows();
    let r = rows
        .iter()
        .find(|r| {
            r.insurer == "EI"
                && r.filing_kind == "ACQUIRE"
                && r.in_force(date!(2027 - 01 - 01)).unwrap()
        })
        .unwrap();
    assert!(matches!(
        applicability(&r.exclusions, &ordinary(), date!(2027 - 01 - 01)).unwrap(),
        Applicability::Unknown { .. }
    ));
    let historic = rows
        .iter()
        .find(|r| {
            r.insurer == "EI"
                && r.filing_kind == "ACQUIRE"
                && r.in_force(date!(2026 - 09 - 01)).unwrap()
        })
        .unwrap();
    assert_eq!(historic.citation.promulgation, "대통령령 제36472호");
    assert_eq!(
        dates(historic, &anchors(date!(2026 - 09 - 01)), &[])
            .unwrap()
            .due_on
            .as_deref(),
        Some("2026-10-15")
    );
    assert!(rule("NHIS", "ACQUIRE").penalty.is_none());
}
