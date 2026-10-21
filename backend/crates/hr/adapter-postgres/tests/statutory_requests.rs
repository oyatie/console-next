#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::{FilingQuery, RequestFiling};
use serde_json::Value;
use sqlx::PgPool;
use support::{principal, tenant, user};
use uuid::Uuid;
use world::{complete, list, register_rules, world};
fn request(event: Uuid, kind: &str, on: &str) -> RequestFiling {
    RequestFiling {
        source_event_id: event,
        filing_kind: serde_json::from_value(serde_json::json!(kind)).expect("a known request kind"),
        anchor_on: on.into(),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn worker_request_updates_the_existing_clock_and_retries_after_filing(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let rules = register_rules(&pool).await;
    let call = || {
        w.tenant.hr.request_insurance_filing(
            p.clone(),
            "requested".into(),
            request(w.event, "ACQUIRE_REQUESTED", "2026-09-05"),
            rules.clone(),
        )
    };
    let page = call().await.unwrap();
    assert_eq!(page.total, 4);
    let ei = page.items.iter().find(|t| t.insurer == "EI").unwrap();
    assert_eq!(ei.kind, "ACQUIRE");
    assert_eq!(ei.opens_on.as_deref(), Some("2026-09-01"));
    assert_eq!(ei.target_on, ei.opens_on);
    assert!(ei.dates.as_ref().unwrap().without_delay);
    assert!(ei.due_on.is_none());
    assert_eq!(call().await.unwrap().total, 4);
    w.tenant
        .hr
        .record_insurance_filing(
            p.clone(),
            (w.event, "ACQUIRE".into(), "EI".into()),
            "filed".into(),
            complete(0),
            rules.clone(),
        )
        .await
        .unwrap();
    assert_eq!(call().await.unwrap().total, 4);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_requests WHERE org_id=$1")
            .bind(w.tenant.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let e = w
        .tenant
        .hr
        .request_insurance_filing(
            p,
            "requested".into(),
            request(w.event, "ACQUIRE_REQUESTED", "2026-09-06"),
            rules,
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, "conflict");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn work_month_and_request_refusals_keep_truthful_anchors_and_audits(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let rules = register_rules(&pool).await;
    let call = |key: &str, b| {
        w.tenant
            .hr
            .request_insurance_filing(p.clone(), key.to_owned(), b, rules.clone())
    };
    let page = call("month", request(w.event, "WORK_CONFIRMATION", "2026-09-30"))
        .await
        .unwrap();
    assert_eq!(page.total, 2);
    for task in &page.items {
        assert_eq!(task.opens_on.as_deref(), Some("2026-10-01"));
        assert_eq!(task.target_on, task.opens_on);
        assert_eq!(task.due_on.as_deref(), Some("2026-10-15"));
    }
    let task = page.items.iter().find(|t| t.insurer == "EI").unwrap();
    let mut b = complete(0);
    b.completed_on = Some("2026-10-01".into());
    b.applicability_facts.as_mut().unwrap().daily = Some(true);
    w.tenant
        .hr
        .record_insurance_filing(
            p.clone(),
            (task.event_id, task.kind.clone(), task.insurer.clone()),
            "work-filed".into(),
            b,
            rules.clone(),
        )
        .await
        .unwrap();
    let page = w
        .tenant
        .hr
        .insurance_filings(
            p.clone(),
            FilingQuery {
                event_id: Some(task.event_id),
                ..list()
            },
            rules.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        page.items
            .iter()
            .find(|t| t.insurer == "IACI")
            .unwrap()
            .state,
        "COVERED"
    );
    for (key, b) in [
        (
            "not-month-end",
            request(w.event, "WORK_CONFIRMATION", "2026-09-29"),
        ),
        (
            "duplicate",
            request(w.event, "WORK_CONFIRMATION", "2026-09-30"),
        ),
        (
            "not-in-force",
            request(w.event, "MONTHLY_REMUNERATION", "2026-09-30"),
        ),
        (
            "wrong-source",
            request(w.event, "SEPARATION_CERTIFICATE", "2026-09-05"),
        ),
    ] {
        assert_eq!(
            call(key, b).await.unwrap_err().code,
            if key == "wrong-source" {
                "filing_event_inactive"
            } else {
                "filing_request_invalid"
            }
        );
    }
    let other = tenant(&pool).await;
    let u = user(&pool, other.org, None).await;
    assert_eq!(
        other
            .hr
            .request_insurance_filing(
                principal(other.org, u),
                "foreign".into(),
                request(w.event, "WORK_CONFIRMATION", "2026-09-30"),
                rules
            )
            .await
            .unwrap_err()
            .code,
        "filing_event_inactive"
    );
    let audits: Vec<Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE action='insurance_filing.refused'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for code in ["filing_request_invalid", "filing_event_inactive"] {
        assert!(audits.iter().any(|a| a["code"] == code));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM insurance_filing_requests")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
