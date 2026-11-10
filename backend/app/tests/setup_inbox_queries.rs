// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
// SQL statement telemetry needs its own subscriber process, as in nextest.
#[path = "support/http.rs"]
mod http;
#[path = "support/reference_logs.rs"]
mod reference_logs;
use serde_json::Value;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_operator_loads_its_access_subject_once(pool: PgPool) {
    let (org, ops) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let operator = http::ctx(&pool, org, ops, &["SUPER_ADMIN"], None).await;
    let logs = reference_logs::Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_max_level(tracing::Level::DEBUG)
        .with_writer(move || writer.clone())
        .finish();
    let (status, page) = operator
        .call("GET", "/api/v1/me/action-inbox", None)
        .with_subscriber(subscriber)
        .await;
    assert_eq!(status, ::http::StatusCode::OK, "{page}");
    assert!(
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "setup_entity"),
        "{page}"
    );
    let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    let setup_queries: Vec<Value> = raw
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| {
            event["spans"]
                .as_array()
                .is_some_and(|spans| spans.iter().any(|span| span["source"] == "Setup"))
        })
        .collect();
    let loads = setup_queries
        .iter()
        .filter(|event| {
            event["fields"]["db.statement"]
                .as_str()
                .is_some_and(|sql| sql.contains("SELECT is_tenant_ops, is_active FROM users"))
        })
        .count();
    assert_eq!(
        loads, 1,
        "the setup preflight and readiness share one access subject"
    );
    let transactions = setup_queries
        .iter()
        .filter(|event| {
            event["fields"]["summary"]
                .as_str()
                .is_some_and(|sql| sql.starts_with("SELECT set_config('app.current_org'"))
        })
        .count();
    assert_eq!(
        transactions, 1,
        "the setup source opens one tenant transaction"
    );
}
