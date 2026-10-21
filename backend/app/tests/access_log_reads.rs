#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! PII-READS (U16, BW-26, lane correction #8) through the composed app router
//! as the runtime role: exit-case, dashboard, lifecycle-history, org-chart,
//! account, directory and import-preview reads each write a 접속기록 row with
//! the client IP and the bearer's session family; the IP is the forwarded
//! client only when the socket peer is a configured trusted proxy; a reader
//! without `exit_settlement_manage` gets the settlement without pay figures.

#[path = "access_log_reads/support.rs"]
mod support;

use axum::Router;
use console_app::build_router;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{
    DIRECT_PEER, PROXY_PEER, app_state, get, import_preview, runtime_pool, seed_employee,
    seed_exit_case_with_settlement, seed_user, send, signing_pems, token,
};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn personal_data_reads_record_the_client_ip_session_and_subjects(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'PII reads')")
        .bind(org)
        .bind(format!("pii-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let admin = seed_user(&pool, org, "SUPER_ADMIN").await;
    let executive = seed_user(&pool, org, "EXECUTIVE").await;
    let employee = seed_employee(&pool, org).await;
    let case = seed_exit_case_with_settlement(&pool, org, employee, admin).await;

    let (private_pem, public_pem) = signing_pems();
    let runtime = runtime_pool(&pool).await;
    let admin_token = token(
        &runtime,
        &private_pem,
        &public_pem,
        admin,
        org,
        "SUPER_ADMIN",
    )
    .await;
    let exec_token = token(
        &runtime,
        &private_pem,
        &public_pem,
        executive,
        org,
        "EXECUTIVE",
    )
    .await;
    let app: Router = build_router(app_state(runtime, public_pem));

    // Through the trusted proxy: the forwarded client is the 접속지.
    let via_proxy = |uri: String| get(uri, &admin_token, PROXY_PEER, "198.51.100.20");
    for uri in [
        "/api/v1/hr/exit-cases".to_owned(),
        format!("/api/v1/hr/exit-cases/{case}"),
        "/api/v1/hr/absence-exit-dashboard".to_owned(),
        format!("/api/v1/employees/{employee}/lifecycle-events"),
        "/api/v1/hr/org-chart".to_owned(),
        "/api/v1/users".to_owned(),
        format!("/api/v1/users/{}", admin.as_uuid()),
        "/api/v1/directory/people".to_owned(),
    ] {
        let (status, body) = send(&app, via_proxy(uri.clone())).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {body}");
    }
    // From an untrusted peer the same header is ignored: the socket IP is recorded.
    let direct = get(
        format!("/api/v1/hr/exit-cases/{case}"),
        &admin_token,
        DIRECT_PEER,
        "198.51.100.99",
    );
    let (status, body) = send(&app, direct).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["settlement_package"]["severance_pay_won"], 9_000_000);
    assert!(body["settlement_package"].get("figures_withheld").is_none());

    let csv = "사번,성명,지점,근무일,출근,퇴근\nE-1,Kim,본사,2026-06-01,09:00,18:00\n";
    let (status, body) = send(&app, import_preview(&admin_token, csv)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // BW-26: EXECUTIVE reads the case but holds no settlement capability.
    let exec_read = get(
        format!("/api/v1/hr/exit-cases/{case}"),
        &exec_token,
        DIRECT_PEER,
        "",
    );
    let (status, body) = send(&app, exec_read).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let package = &body["settlement_package"];
    assert_eq!(package["figures_withheld"], true, "{body}");
    for figure in [
        "severance_pay_won",
        "average_wage_total_won",
        "average_daily_wage_milliwon",
        "monthly_ordinary_wage_won",
    ] {
        assert!(package.get(figure).is_none(), "{figure}: {body}");
    }
    assert_eq!(package["statutory_basis"], json!({}));
    let documents = json!({ "certification_status": "UNCERTIFIED_DRAFT" });
    assert_eq!(package["insurance_loss_payload"], documents);
    assert_eq!(package["approval_payload"], documents);
    assert!(!body.to_string().contains("9000000"), "{body}");

    let rows: Vec<(String, String, String, Option<String>, Value)> = sqlx::query_as(
        "SELECT action, target_type, target_id, ip, after_snap FROM audit_events \
         WHERE org_id = $1 AND actor = $2 AND action LIKE ANY(ARRAY['employee%.%read', \
         'account.%', 'directory.%', 'attendance_import.preview']) \
         ORDER BY occurred_at, created_at",
    )
    .bind(org)
    .bind(*admin.as_uuid())
    .fetch_all(&pool)
    .await
    .unwrap();
    let summary: Vec<(&str, &str, &str, Option<&str>)> = rows
        .iter()
        .map(|(action, kind, target, ip, _)| {
            (
                action.as_str(),
                kind.as_str(),
                target.as_str(),
                ip.as_deref(),
            )
        })
        .collect();
    let (case_id, employee_id, admin_id) = (
        case.to_string(),
        employee.to_string(),
        admin.as_uuid().to_string(),
    );
    let proxied = Some("198.51.100.20");
    assert_eq!(
        summary[..summary.len() - 1],
        [
            (
                "employee_exit_case.list_read",
                "employee_exit_case",
                "query",
                proxied
            ),
            (
                "employee_exit_case.read",
                "employee_exit_case",
                case_id.as_str(),
                proxied
            ),
            (
                "employee_exit_case.list_read",
                "employee_exit_case",
                "query",
                proxied
            ),
            (
                "employee.lifecycle_read",
                "employee",
                employee_id.as_str(),
                proxied
            ),
            ("employee.org_chart_read", "employee", "query", proxied),
            ("account.list_read", "user", "query", proxied),
            ("account.read", "user", admin_id.as_str(), proxied),
            ("directory.list_read", "user", "query", proxied),
            (
                "employee_exit_case.read",
                "employee_exit_case",
                case_id.as_str(),
                Some("203.0.113.7")
            ),
        ],
        "{rows:#?}"
    );
    let (action, kind, _, ip, after) = rows.last().unwrap();
    assert_eq!(
        (action.as_str(), kind.as_str()),
        ("attendance_import.preview", "data_import_run")
    );
    assert_eq!(ip.as_deref(), Some("203.0.113.7"));
    assert_eq!(after["entity_type"], "attendance_direct");

    let family: Uuid = sqlx::query_scalar(
        "SELECT id FROM auth_refresh_token_families WHERE org_id = $1 AND user_id = $2",
    )
    .bind(org)
    .bind(*admin.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    for (action, _, _, _, after) in &rows {
        assert_eq!(after["session_id"], family.to_string(), "{action}");
        assert_eq!(after["principal_type"], "TENANT_USER", "{action}");
    }
    let subjects = |index: usize| rows[index].4["subject_ids"].clone();
    for index in [0, 1, 2, 3, 8] {
        assert_eq!(subjects(index), json!([employee]), "{:?}", rows[index].0);
    }
    // The org chart is a whole-population read: its row count, like a download.
    assert_eq!(subjects(4), json!([]));
    assert_eq!(rows[4].4["row_count"], 1);
    assert_eq!(rows[6].4["subject_ids"], json!([admin.as_uuid()]));
    assert_eq!(rows[6].4["self_read"], true);
    assert_eq!(rows[1].4["self_read"], false);
}
