// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "../../crates/hr/adapter-postgres/tests/statutory/age_scale.rs"]
mod age_scale;
#[path = "support/http.rs"]
mod http;
#[path = "support/reference_logs.rs"]
mod reference_logs;
#[path = "../../crates/hr/adapter-postgres/tests/emp_create/fixture.rs"]
mod registration;

#[path = "support/inbox_read_scale.rs"]
mod scale;
use scale::{
    assert_count_cohorts, assert_source_isolation, explain_filing_hydration, explain_register, seed,
};

use serde_json::Value;
use sqlx::PgPool;
use std::time::{Duration, Instant};
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

const FIRST: &str = "/api/v1/me/action-inbox?filter=turn&limit=50";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn inbox_first_page_budget_scales_without_per_person_statements_or_cross_tenant_rows(
    pool: PgPool,
) {
    assert_count_cohorts(&pool).await;
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, site, branch, unit) = http::structure(&ctx).await;
    let (other_org, other_user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let other = http::ctx(&pool, other_org, other_user, &["SUPER_ADMIN"], None).await;
    let (other_entity, other_site, other_branch, other_unit) = http::structure(&other).await;
    seed(
        &pool,
        other_org,
        other_user,
        (&other_entity, &other_site, &other_branch, &other_unit),
        2_000,
    )
    .await;
    let mut measurements = Vec::new();
    for size in [2_000, 4_000] {
        seed(&pool, org, user, (&entity, &site, &branch, &unit), size).await;
        let logs = reference_logs::Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(move || writer.clone())
            .finish();
        let (status, page) = ctx
            .call("GET", FIRST, None)
            .with_subscriber(subscriber)
            .await;
        assert_eq!(status, ::http::StatusCode::OK, "{page}");
        let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        let events: Vec<Value> = raw
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(
            events
                .iter()
                .filter(|event| event["target"] == "sqlx::query"
                    && event["fields"]["db.statement"]
                        .as_str()
                        .is_some_and(|sql| sql.contains("FROM lifecycle_statutory_rules r")))
                .count(),
            1,
            "numeric and filing rules must share one register scan"
        );
        let statements = events
            .iter()
            .filter(|e| e["target"] == "sqlx::query")
            .count();
        for event in &events {
            if event["fields"]["message"] == "inbox source measured" {
                eprintln!(
                    "people={size}, source={}, seconds={}",
                    event["span"]["source"], event["fields"]["work_seconds"]
                );
            }
        }
        explain_register(&pool, org, &page, &events).await;
        explain_filing_hydration(&pool, org, &page, &events).await;
        if size == 2_000 {
            assert_source_isolation(&pool, &ctx).await;
        }
        let mut samples = Vec::new();
        // SQL formatting and capture must not be part of the endpoint's latency budget.
        for _ in 0..20 {
            let start = Instant::now();
            let (status, page) = ctx.call("GET", FIRST, None).await;
            samples.push(start.elapsed());
            assert_eq!(status, ::http::StatusCode::OK, "{page}");
            assert_eq!(page["unavailable"], serde_json::json!([]));
            assert_eq!(page["items"].as_array().unwrap().len(), 50);
            let mut ids: Vec<Uuid> = page["items"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|item| item["links"].as_array().unwrap())
                .filter(|link| link["kind"] == "employee")
                .map(|link| link["id"].as_str().unwrap().parse().unwrap())
                .collect();
            ids.extend(page["items"].as_array().unwrap().iter().filter_map(|item| {
                item["context"]["insurance"]["employee_id"]
                    .as_str()
                    .map(|id| id.parse::<Uuid>().unwrap())
            }));
            assert!(!ids.is_empty(), "the measured page must contain people");
            let foreign: i64 =
                sqlx::query_scalar("SELECT count(*) FROM employees WHERE org_id=$1 AND id=ANY($2)")
                    .bind(other_org)
                    .bind(&ids)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(foreign, 0, "another tenant's people entered the inbox");
        }
        samples.sort();
        measurements.push((samples[18], statements));
        eprintln!(
            "people={size}, p95={:?}, statements={statements}",
            samples[18]
        );
    }
    assert!(
        measurements[1].1 <= measurements[0].1,
        "statement count grew with people: {measurements:?}"
    );
    assert!(
        measurements[1].0 <= measurements[0].0 * 5 / 2,
        "superlinear inbox growth: {measurements:?}"
    );
    assert!(
        measurements[0].0 <= Duration::from_millis(300),
        "first page exceeded its existing budget: {measurements:?}"
    );
}
