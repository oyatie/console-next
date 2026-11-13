// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "access_log_reads/support.rs"]
mod fixtures;
#[path = "support/http.rs"]
mod http;
mod inbox_pool;
#[path = "support/reference_logs.rs"]
mod reference_logs;
mod settings_support;
use ::http::StatusCode;
use console_compliance_adapter_postgres::{PgComplianceStore, rights};
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
                && e["fields"]["db.statement"].as_str().is_some_and(|s| {
                    s.contains("SELECT code, effective_from")
                        && s.contains("FROM lifecycle_statutory_rules")
                })
        })
        .count()
}

#[test]
fn register_counter_observes_plain_and_scoped_reads_without_counting_filing_queries() {
    let events: Vec<_> = [
        "SELECT code, effective_from FROM lifecycle_statutory_rules ORDER BY code, effective_from",
        "WITH available AS MATERIALIZED (SELECT r.* FROM lifecycle_statutory_rules r) SELECT code, effective_from FROM available ORDER BY code,effective_from",
        "SELECT filing_rule,trigger_event_kinds FROM lifecycle_statutory_rules WHERE filing_rule IS NOT NULL ORDER BY code,effective_from",
        "WITH available AS MATERIALIZED (SELECT r.* FROM lifecycle_statutory_rules r) SELECT filing_rule,trigger_event_kinds FROM available WHERE filing_rule IS NOT NULL ORDER BY code,effective_from",
        "SELECT code, effective_from FROM insurance_loss_codes ORDER BY code, effective_from",
    ]
    .into_iter()
    .map(|sql| serde_json::json!({"target":"sqlx::query","fields":{"db.statement":sql}}))
    .collect();
    assert_eq!(register_reads(&events[..1]), 1);
    assert_eq!(register_reads(&events[1..2]), 1);
    assert_eq!(register_reads(&events[2..]), 0);
    assert_eq!(register_reads(&events), 2);
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_due_read_from_the_statutory_register_says_so_and_no_other_due_does(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let employee = fixtures::seed_employee(&pool, org).await;
    fixtures::seed_exit_case_with_settlement(&pool, org, employee, user).await;
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,'ONBOARD','ACTIVE',CURRENT_DATE::text,'register read',$3,'APPLIED')")
        .bind(org).bind(employee).bind(user.as_uuid()).execute(&pool).await.unwrap();
    // A case still awaiting confirmation is due on the exit date itself, which no register row sets.
    sqlx::query("UPDATE employees SET employee_number = id::text WHERE id = $1")
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    let leaver = fixtures::seed_employee(&pool, org).await;
    let reported = fixtures::seed_exit_case_with_settlement(&pool, org, leaver, user).await;
    sqlx::query("UPDATE employee_exit_cases SET status = 'REPORTED' WHERE id = $1")
        .bind(reported)
        .execute(&pool)
        .await
        .unwrap();
    // A privacy rights request reaches a handler who may edit HR records, not its own subject.
    let hr = http::add_user(&pool, org, &["MEMBER"]).await;
    let grant = settings_support::seed_role_and_grant(&pool, org, user, hr, "TENANT", None).await;
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) SELECT org_id,role_id,2,name_ko,status,change_mode,created_by FROM access_role_versions WHERE org_id=$1 AND version=1 AND role_id=(SELECT role_id FROM access_grants WHERE id=$2)")
        .bind(org).bind(grant).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,role_id,2,'hr_basic',ARRAY['edit'] FROM access_grants WHERE org_id=$1 AND id=$2")
        .bind(org).bind(grant).execute(&pool).await.unwrap();
    sqlx::query("UPDATE access_roles SET version=2 WHERE org_id=$1 AND id=(SELECT role_id FROM access_grants WHERE id=$2)")
        .bind(org).bind(grant).execute(&pool).await.unwrap();
    let runtime = fixtures::runtime_pool(&pool).await;
    let register = PgComplianceStore::new(runtime.clone())
        .statutory_register()
        .await
        .unwrap();
    let tenant = console_kernel_core::OrgId::from_uuid(org);
    let filing = serde_json::from_str(r#"{"controller":"TENANT","kinds":["ACCESS"]}"#).unwrap();
    let mut tx = rights::begin(&runtime, tenant).await.unwrap();
    rights::file(&mut tx, tenant, user, Some(employee), &filing, &register)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (page, _) = read(&ctx).await;
    let (intake, _) = read(&http::ctx(&pool, org, hr, &["MEMBER"], None).await).await;
    let items: Vec<&Value> = [&page, &intake]
        .into_iter()
        .flat_map(|p| p["items"].as_array().unwrap())
        .collect();
    let marked = ["insurance_filing", "hr_exit_settle", "privacy_request"];
    let dated: Vec<_> = items.iter().filter(|i| i.get("due").is_some()).collect();
    for kind in marked.into_iter().chain(["hr_exit_confirm"]) {
        assert!(
            dated.iter().any(|i| i["kind"] == kind),
            "no dated {kind}: {page} {intake}"
        );
    }
    for item in &items {
        let statutory = marked.iter().any(|k| item["kind"] == *k) && item.get("due").is_some();
        assert_eq!(
            item.get("due_basis").and_then(Value::as_str),
            statutory.then_some("statutory"),
            "{item}"
        );
    }
}
