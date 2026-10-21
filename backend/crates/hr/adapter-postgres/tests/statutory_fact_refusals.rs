#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use serde_json::Value;
use sqlx::PgPool;
use support::principal;
use world::{complete, list, register_rules, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unverified_and_contradictory_facts_cannot_create_a_filing_receipt(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let rules = register_rules(&pool).await;
    let mut unknown = complete(0);
    unknown.applicability_facts = None;
    let mut contradictory = complete(0);
    contradictory
        .applicability_facts
        .as_mut()
        .unwrap()
        .birth_date = Some("1950-01-01".into());
    for (key, body) in [("unknown", unknown), ("contradictory-birth", contradictory)] {
        let e = w
            .tenant
            .hr
            .record_insurance_filing(
                p.clone(),
                (w.event, "ACQUIRE".into(), "NPS".into()),
                key.into(),
                body,
                rules.clone(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            (e.status.as_u16(), e.code),
            (422, "filing_applicability_unverified")
        );
        let audit: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='insurance_filing.refused' ORDER BY occurred_at DESC LIMIT 1")
            .bind(w.tenant.org).fetch_one(&pool).await.unwrap();
        assert_eq!(audit["code"], "filing_applicability_unverified");
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE event_id=$1")
                .bind(w.event)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }
    let page = w
        .tenant
        .hr
        .insurance_filings(p, list(), rules)
        .await
        .unwrap();
    let task = page.items.iter().find(|t| t.insurer == "NPS").unwrap();
    assert_eq!(task.state, "PENDING");
    assert_eq!(task.version, 0);
    assert!(task.completed_on.is_none() && task.receipt_number.is_none());
}
