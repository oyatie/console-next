#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use console_compliance_domain::statutory::filing::{FilingAnchors, FilingRule, dates};
use sqlx::PgPool;
use time::{Date, Month, macros::date};
use world::register_rules;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn deployed_slices_cover_historical_events_and_never_cite_future_support(pool: PgPool) {
    let register = register_rules(&pool).await;
    for on in [
        date!(2024 - 02 - 29),
        date!(2025 - 01 - 01),
        date!(2026 - 09 - 01),
        date!(2026 - 10 - 08),
    ] {
        for insurer in ["NPS", "NHIS", "EI", "IACI"] {
            for kind in ["ACQUIRE", "LOSE"] {
                let rule = register.filing_rule(insurer, kind, on).unwrap().unwrap();
                assert!(
                    dates(
                        rule,
                        &FilingAnchors {
                            effective_date: Some(on),
                            acquire_date: Some(on),
                            exit_date: Some(on),
                            loss_date: on.next_day(),
                            ..FilingAnchors::default()
                        },
                        &[]
                    )
                    .unwrap()
                    .due_on
                    .is_some()
                );
            }
        }
    }
    let rules: Vec<serde_json::Value> =
        sqlx::query_scalar("SELECT filing_rule FROM statutory_rules WHERE filing_rule IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(rules.len() > 400);
    for value in rules {
        let r: FilingRule = serde_json::from_value(value).unwrap();
        r.validate().unwrap();
        for citation in r
            .applicability_citations
            .iter()
            .chain(r.penalty.iter().map(|p| &p.citation))
        {
            assert!(
                citation.enforced_on <= r.effective_from,
                "{} {}",
                r.code,
                r.effective_from
            );
            assert!(citation.source_url.starts_with("https://www.law.go.kr/"));
        }
        for year in [2024, 2026, 2027] {
            for month in 1..=12 {
                let month = Month::try_from(month).unwrap();
                for day in [1, month.length(year)] {
                    let on = Date::from_calendar_date(year, month, day).unwrap();
                    let a = FilingAnchors {
                        effective_date: Some(on),
                        acquire_date: Some(on),
                        exit_date: Some(on),
                        loss_date: on.next_day(),
                        request_date: Some(on),
                        work_month: Some(on),
                    };
                    let d = dates(&r, &a, &[]).unwrap();
                    assert_eq!(d.target_on, d.opens_on);
                    if let (Some(conservative), Some(candidate)) =
                        (d.due_on, d.legal_latest_candidate)
                    {
                        assert!(conservative <= candidate);
                    }
                }
            }
        }
    }
    let r = register
        .filing_rule("EI", "ACQUIRE", date!(1995 - 05 - 01))
        .unwrap()
        .unwrap();
    assert_eq!(r.deadline.value, Some(14));
    assert_eq!(
        r.deadline.kind,
        console_compliance_domain::statutory::filing::FilingRuleKind::DayOfNextMonth
    );
    let r = register
        .filing_rule("NPS", "ACQUIRE", date!(1988 - 01 - 01))
        .unwrap()
        .unwrap();
    assert_eq!(r.deadline.value, Some(14));
    assert_eq!(
        r.deadline.kind,
        console_compliance_domain::statutory::filing::FilingRuleKind::Days
    );
}
