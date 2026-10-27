// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "access_log_reads/support.rs"]
mod fixtures;
#[path = "support/http.rs"]
mod http;
mod inbox_pool;
#[path = "support/reference_logs.rs"]
mod reference_logs;
use ::http::StatusCode;
use serde_json::Value;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

const HOME: &str = "/api/v1/me/action-inbox?filter=turn";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn home_exit_access_is_one_batch_of_visible_subjects_and_absent_without_cases(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let mut subjects = std::collections::BTreeSet::new();
    let mut cases = std::collections::BTreeSet::new();
    for _ in 0..2 {
        let employee = fixtures::seed_employee(&pool, org).await;
        sqlx::query("UPDATE employees SET employee_number = id::text WHERE id = $1")
            .bind(employee)
            .execute(&pool)
            .await
            .unwrap();
        cases.insert(fixtures::seed_exit_case_with_settlement(&pool, org, employee, user).await);
        subjects.insert(employee);
    }
    for visible in [false, true] {
        sqlx::query("UPDATE employee_exit_cases SET status = $2 WHERE org_id = $1")
            .bind(org)
            .bind(if visible {
                "SETTLEMENT_READY"
            } else {
                "CANCELLED"
            })
            .execute(&pool)
            .await
            .unwrap();
        let (page, _) = read(&ctx).await;
        assert_eq!(page["unavailable"], serde_json::json!([]));
        let shown: std::collections::BTreeSet<uuid::Uuid> = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["kind"] == "hr_exit_settle")
            .flat_map(|i| i["links"].as_array().unwrap())
            .filter(|l| l["kind"] == "employee")
            .map(|l| l["id"].as_str().unwrap().parse().unwrap())
            .collect();
        let rows: Vec<Value> = sqlx::query_scalar(
            "SELECT after_snap FROM audit_events WHERE org_id = $1 AND target_type = 'employee_exit_case'"
        ).bind(org).fetch_all(&pool).await.unwrap();
        if visible {
            assert_eq!(shown, subjects);
            assert_eq!(rows.len(), 1, "Home must record one exit access batch");
            let logged: std::collections::BTreeSet<uuid::Uuid> =
                serde_json::from_value(rows[0]["subject_ids"].clone()).unwrap();
            assert_eq!(logged, subjects);
            let logged_cases: std::collections::BTreeSet<uuid::Uuid> =
                serde_json::from_value(rows[0]["case_ids"].clone()).unwrap();
            assert_eq!(logged_cases, cases);
            assert_eq!(rows[0]["view"], "action_inbox");
        } else {
            assert!(shown.is_empty());
            assert!(
                rows.is_empty(),
                "no visible case means no exit access event"
            );
        }
    }
}

async fn read(ctx: &http::Ctx) -> (Value, Vec<Value>) {
    let logs = reference_logs::Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_max_level(tracing::Level::DEBUG)
        .with_writer(move || writer.clone())
        .finish();
    let (status, page) = ctx
        .call("GET", HOME, None)
        .with_subscriber(subscriber)
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    (
        page,
        raw.lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect(),
    )
}

fn register_reads(events: &[Value]) -> usize {
    events
        .iter()
        .filter(|e| {
            e["target"] == "sqlx::query"
                && e["fields"]["db.statement"]
                    .as_str()
                    .is_some_and(|s| s.contains("FROM lifecycle_statutory_rules ORDER BY"))
        })
        .count()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn insurance_and_settlement_share_one_register_and_next_request_reads_again(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let employee = fixtures::seed_employee(&pool, org).await;
    fixtures::seed_exit_case_with_settlement(&pool, org, employee, user).await;
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,'ONBOARD','ACTIVE',CURRENT_DATE::text,'register read',$3,'APPLIED')")
        .bind(org).bind(employee).bind(user.as_uuid()).execute(&pool).await.unwrap();
    for _ in 0..2 {
        let (page, events) = read(&ctx).await;
        assert_eq!(page["unavailable"], serde_json::json!([]));
        let items = page["items"].as_array().unwrap();
        assert!(
            items.iter().any(|i| i["kind"] == "hr_exit_settle"),
            "{page}"
        );
        assert!(
            items.iter().any(|i| i["kind"] == "insurance_filing"),
            "{page}"
        );
        assert_eq!(register_reads(&events), 1, "one register load per request");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_fault_keeps_its_cause_is_shared_and_retries_on_next_request(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let employee = fixtures::seed_employee(&pool, org).await;
    fixtures::seed_exit_case_with_settlement(&pool, org, employee, user).await;
    sqlx::query("ALTER TABLE insurance_loss_codes RENAME TO unavailable_loss_codes")
        .execute(&pool)
        .await
        .unwrap();
    let (page, events) = read(&ctx).await;
    assert!(
        page["unavailable"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["source"] == "hr_insurance")
    );
    assert!(
        events
            .iter()
            .any(|e| e["fields"]["failure_kind"] == "register_fault"
                && e["fields"]["error"]
                    .as_str()
                    .is_some_and(|s| s.contains("insurance_loss_codes"))),
        "error events: {:?}",
        events
            .iter()
            .filter(|e| e["level"] == "ERROR")
            .collect::<Vec<_>>()
    );
    assert_eq!(
        register_reads(&events),
        1,
        "cache the failure within the request too"
    );
    assert!(!page.to_string().contains("insurance_loss_codes"));
    sqlx::query("ALTER TABLE unavailable_loss_codes RENAME TO insurance_loss_codes")
        .execute(&pool)
        .await
        .unwrap();
    let (page, events) = read(&ctx).await;
    assert_eq!(page["unavailable"], serde_json::json!([]));
    assert_eq!(register_reads(&events), 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn filing_fault_logs_the_real_error_without_disclosing_it(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    sqlx::query("ALTER TABLE insurance_filing_records RENAME TO unavailable_filing_records")
        .execute(&pool)
        .await
        .unwrap();
    let (page, events) = read(&ctx).await;
    assert!(events.iter().any(|e| {
        e["fields"]["source"] == "hr_insurance"
            && e["fields"]["message"] == "action-inbox source read failed"
            && e["fields"]["error"]
                .as_str()
                .is_some_and(|s| !s.contains("failed to load insurance filings"))
    }));
    // HrError sanitizes SQL failures at the adapter; its original cause stays in the same source span.
    assert!(events.iter().any(|e| {
        e["span"]["source"] == "HrInsurance"
            && e["fields"]["error"]
                .as_str()
                .is_some_and(|s| s.contains("insurance_filing_records"))
    }));
    assert!(!page.to_string().contains("insurance_filing_records"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cold_setup_eight_concurrent_home_reads_keep_every_source_available(pool: PgPool) {
    for attempt in 0..10 {
        let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
        let (ctx, probe) = inbox_pool::context(&pool, org, user).await;
        let pages = futures::future::join_all((0..8).map(|_| ctx.call("GET", HOME, None))).await;
        for (status, page) in pages {
            assert_eq!(status, StatusCode::OK, "run {attempt}: {page}");
            assert_eq!(
                page["unavailable"],
                serde_json::json!([]),
                "run {attempt}: {page}"
            );
        }
        probe.pool.close().await;
    }
}
