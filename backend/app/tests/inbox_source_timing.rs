// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "../../crates/hr/adapter-postgres/tests/statutory/age_scale.rs"]
mod age_scale;
#[path = "support/http.rs"]
mod http;
#[path = "support/reference_logs.rs"]
mod reference_logs;
use serde_json::Value;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn source_work_and_permit_wait_are_measured_separately_even_on_failure(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, site, _, _) = http::structure(&ctx).await;
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at='2020-01-01',go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(org).bind(user.as_uuid()).execute(&pool).await.unwrap();
    age_scale::seed(
        &pool,
        org,
        user,
        entity.parse().unwrap(),
        site.parse().unwrap(),
        1999,
        6,
    )
    .await;
    for fail in [false, true] {
        if fail {
            sqlx::query("ALTER TABLE change_requests RENAME TO unavailable_requests")
                .execute(&pool)
                .await
                .unwrap();
        }
        let logs = reference_logs::Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(move || writer.clone())
            .finish();
        let (status, page) = ctx
            .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
            .with_subscriber(subscriber)
            .await;
        let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        let mut timings: Vec<Value> = raw
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .filter(|v: &Value| v["fields"]["message"] == "inbox source measured")
            .collect();
        if status != ::http::StatusCode::OK {
            eprintln!(
                "partial costs: {}",
                serde_json::to_string(&timings).unwrap()
            );
        }
        assert_eq!(status, ::http::StatusCode::OK, "{page}");
        let sources: std::collections::BTreeSet<_> = timings
            .iter()
            .map(|e| e["span"]["source"].as_str().unwrap())
            .collect();
        assert_eq!(
            sources.len(),
            console_action_inbox_application::ActionInboxSource::ALL.len(),
            "each source must report work and permit wait"
        );
        for event in &timings {
            assert!(event["fields"]["permit_wait_seconds"].as_f64().unwrap() >= 0.0);
            assert!(event["fields"]["work_seconds"].as_f64().unwrap() >= 0.0);
        }
        timings.sort_by(|a, b| {
            b["fields"]["work_seconds"]
                .as_f64()
                .partial_cmp(&a["fields"]["work_seconds"].as_f64())
                .unwrap()
        });
        let costs: Vec<_> = timings.iter().map(|e| serde_json::json!({"source":e["span"]["source"], "work_seconds":e["fields"]["work_seconds"], "permit_wait_seconds":e["fields"]["permit_wait_seconds"]})).collect();
        eprintln!(
            "source costs (1999 birthdays; failure={fail}): {}",
            serde_json::to_string(&costs).unwrap()
        );
        assert!(timings.iter().any(|e| e["span"]["source"] == "HrInsurance"));
        if fail {
            assert!(timings.iter().any(|e| e["span"]["source"] == "HrRequests"));
            assert!(!page["unavailable"].as_array().unwrap().is_empty());
        }
    }
}
