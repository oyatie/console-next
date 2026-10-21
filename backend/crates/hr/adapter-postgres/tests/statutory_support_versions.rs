#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use console_compliance_domain::statutory::filing::{FilingAnchors, dates};
use sqlx::PgPool;
use time::macros::date;
use world::register_rules;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn supporting_law_changes_update_citations_without_changing_filing_clocks(pool: PgPool) {
    let register = register_rules(&pool).await;
    for (insurer, instrument, before, on) in [
        (
            "NPS",
            "국민연금법",
            date!(2026 - 06 - 16),
            date!(2026 - 06 - 17),
        ),
        (
            "NHIS",
            "국민건강보험법 시행령",
            date!(2026 - 02 - 18),
            date!(2026 - 02 - 19),
        ),
        (
            "EI",
            "고용보험법",
            date!(2026 - 11 - 26),
            date!(2026 - 11 - 27),
        ),
    ] {
        let old = register
            .filing_rule(insurer, "ACQUIRE", before)
            .unwrap()
            .unwrap();
        let current = register
            .filing_rule(insurer, "ACQUIRE", on)
            .unwrap()
            .unwrap();
        let citation = current
            .applicability_citations
            .iter()
            .find(|c| c.instrument == instrument)
            .unwrap();
        assert_eq!(citation.enforced_on, on.to_string());
        assert_ne!(old.applicability_citations, current.applicability_citations);
        assert_eq!(old.deadline, current.deadline);
        assert_eq!(old.exclusions, current.exclusions);
        let anchors = FilingAnchors {
            acquire_date: Some(on),
            effective_date: Some(on),
            ..FilingAnchors::default()
        };
        assert_eq!(
            dates(old, &anchors, &[]).unwrap(),
            dates(current, &anchors, &[]).unwrap()
        );
    }
    let october = register
        .filing_rule("NPS", "ACQUIRE", date!(2026 - 10 - 12))
        .unwrap()
        .unwrap();
    assert!(
        october
            .applicability_citations
            .iter()
            .any(|c| c.instrument == "국민연금법" && c.enforced_on == "2026-06-17")
    );
}
