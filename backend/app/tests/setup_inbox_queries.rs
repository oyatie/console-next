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
    assert_shared_authorization(pool, "/api/v1/me/action-inbox", false).await;
}

#[cfg(feature = "workspace")]
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workbench_inbox_loads_its_access_subject_once(pool: PgPool) {
    assert_shared_authorization(pool, "/api/v1/me/workbench", true).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn granted_reader_reuses_its_principal_projection_for_the_inbox(pool: PgPool) {
    assert_shared_authorization(pool, "/api/v1/me/action-inbox", true).await;
}

async fn assert_shared_authorization(pool: PgPool, endpoint: &str, granted: bool) {
    let (org, ops) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let user = if granted {
        let user = http::add_user(&pool, org, &[]).await;
        let role = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'설정 담당','ACTIVE',1,$3)")
            .bind(org).bind(role).bind(ops.as_uuid()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'설정 담당','ACTIVE','SETUP',$3)")
            .bind(org).bind(role).bind(ops.as_uuid()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'settings',ARRAY['view','edit'])")
            .bind(org).bind(role).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)")
            .bind(org).bind(user.as_uuid()).bind(role).bind(ops.as_uuid()).execute(&pool).await.unwrap();
        user
    } else {
        ops
    };
    let roles: &[&str] = if granted { &[] } else { &["SUPER_ADMIN"] };
    let operator = http::ctx(&pool, org, user, roles, None).await;
    let logs = reference_logs::Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_max_level(tracing::Level::DEBUG)
        .with_writer(move || writer.clone())
        .finish();
    let (status, page) = operator
        .call("GET", endpoint, None)
        .with_subscriber(subscriber)
        .await;
    let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert_eq!(
        status,
        ::http::StatusCode::OK,
        "{page}\n{}",
        raw.lines().rev().take(12).collect::<Vec<_>>().join("\n")
    );
    let page = if endpoint.ends_with("workbench") {
        assert_eq!(page["action_inbox"]["status"], "ok", "{page}\n{raw}");
        &page["action_inbox"]
    } else {
        &page
    };
    assert!(
        page["items"].as_array().unwrap().iter().any(|item| {
            item["kind"]
                == if granted {
                    "grant_notice"
                } else {
                    "setup_entity"
                }
                || item["source"]["kind"]
                    == if granted {
                        "grant_notice"
                    } else {
                        "setup_entity"
                    }
        }),
        "{page}"
    );
    let setup_queries: Vec<Value> = raw
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| {
            event["spans"]
                .as_array()
                .is_some_and(|spans| spans.iter().any(|span| span["source"] == "Setup"))
        })
        .collect();
    let loads = raw
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| {
            event["fields"]["db.statement"]
                .as_str()
                .is_some_and(|sql| sql.contains("SELECT is_tenant_ops, is_active FROM users"))
        })
        .count();
    assert_eq!(
        loads, 1,
        "principal resolution and all inbox sources share one access subject"
    );
    let compilations = raw
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| {
            event["fields"]["message"] == "compiling Cedar access slice"
                && event["fields"]["phase"] == "Setup"
        })
        .count();
    assert_eq!(
        compilations, 1,
        "all sources share one compiled Cedar slice"
    );
    if granted {
        assert!(
            !raw.contains("FROM lifecycle_statutory_rules"),
            "a refused insurance reader must not load the statutory register"
        );
    }
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

    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=clock_timestamp(),go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(org).bind(ops.as_uuid()).execute(&pool).await.unwrap();
    let logs = reference_logs::Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_max_level(tracing::Level::DEBUG)
        .with_writer(move || writer.clone())
        .finish();
    let (status, page) = operator
        .call("GET", endpoint, None)
        .with_subscriber(subscriber)
        .await;
    let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert_eq!(status, ::http::StatusCode::OK, "{page}\n{raw}");
    if endpoint.ends_with("workbench") {
        assert_eq!(page["action_inbox"]["status"], "ok", "{page}\n{raw}");
    }
    // Operating has no prospective setup evaluation: count every compilation.
    let events: Vec<Value> = raw
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["fields"]["message"] == "compiling Cedar access slice")
            .count(),
        1,
        "{raw}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["fields"]["db.statement"]
                .as_str()
                .is_some_and(|sql| sql.contains("SELECT is_tenant_ops, is_active FROM users")))
            .count(),
        1,
        "{raw}"
    );
}
