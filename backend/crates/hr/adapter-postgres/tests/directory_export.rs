#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! PEOPLE-B export: the 용도 is required (a refusal is logged), the download
//! is logged before the first byte, the list filters apply, every row comes
//! (no LIMIT 10000) and the body starts with a UTF-8 BOM. Plus the exit-case
//! search and the 409 exit_case_open for a second open case.

mod support;

use console_hr_adapter_postgres::directory::read_export::ExportPurposeQuery;
use console_hr_adapter_postgres::exits::types::{ExitCaseListQuery, ReportEmployeeExitCaseRequest};
use futures::StreamExt;
use serde_json::json;
use sqlx::PgPool;
use support::{access_rows, employee, no_filters, principal, query, tenant, user};

fn purpose(value: Option<&str>) -> ExportPurposeQuery {
    ExportPurposeQuery {
        export_purpose: value.map(str::to_owned),
        layout: None,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn export_without_a_purpose_is_refused_and_the_refusal_is_logged(pool: PgPool) {
    let t = tenant(&pool).await;
    employee(&pool, t.org, "Kim", "A-1", "ACTIVE").await;
    let hr_user = user(&pool, t.org, None).await;
    for given in [None, Some("FOR_FUN")] {
        let err =
            t.hr.export_employees_csv(principal(t.org, hr_user), no_filters(), purpose(given))
                .await
                .unwrap_err();
        assert_eq!(
            (err.status.as_u16(), err.code),
            (422, "export_purpose_required")
        );
    }
    let rows = access_rows(&pool, t.org).await;
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter()
            .all(|(action, _, _)| action == "employee.export_refused")
    );
    let logs: i64 = sqlx::query_scalar("SELECT count(*) FROM excel_export_logs WHERE org_id = $1")
        .bind(t.org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(logs, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn export_logs_first_then_streams_every_filtered_row_with_a_bom(pool: PgPool) {
    let t = tenant(&pool).await;
    // 10,001 ACTIVE rows (past the old LIMIT 10000) and one EXITED row.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (org_id, company, name, employee_number, employment_status, \
         source_filename, source_sheet, source_row, source_key, raw_row, source_metadata) \
         SELECT $1, 'Test', '=SUM(A1)' || n, 'N-' || n, 'ACTIVE', 'test.xlsx', 'Sheet', n, \
                'key-' || n, '{}', '{}' FROM generate_series(1, 10001) n",
    )
    .bind(t.org)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    employee(&pool, t.org, "Gone", "X-1", "EXITED").await;
    let hr_user = user(&pool, t.org, None).await;

    let (file_name, chunks) =
        t.hr.export_employees_csv(
            principal(t.org, hr_user),
            query(json!({ "status": "ACTIVE" })),
            purpose(Some("INTERNAL_REVIEW")),
        )
        .await
        .unwrap();
    assert_eq!(file_name, "employees-standard.csv");
    // Logged before the first byte was read.
    let (purpose_logged, kind): (String, String) = sqlx::query_as(
        "SELECT export_purpose, export_kind FROM excel_export_logs WHERE org_id = $1",
    )
    .bind(t.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (purpose_logged.as_str(), kind.as_str()),
        ("INTERNAL_REVIEW", "employee_directory")
    );
    let rows = access_rows(&pool, t.org).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "employee.export");
    assert_eq!(rows[0].2["export_purpose"], "INTERNAL_REVIEW");
    assert_eq!(rows[0].2["row_count"], 10_001);
    let mut expected: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT id FROM employees WHERE org_id=$1 AND employment_status='ACTIVE' ORDER BY id",
    )
    .bind(t.org)
    .fetch_all(&pool)
    .await
    .unwrap();
    expected.sort_unstable();
    assert_eq!(rows[0].2["subject_ids"], json!(expected));
    assert_eq!(rows[0].2["subject_count"], 10_001);

    let body = chunks
        .map(|chunk| chunk.unwrap())
        .collect::<Vec<_>>()
        .await
        .concat();
    assert!(body.starts_with("\u{feff}company,name,employee_number,"));
    let lines = body.trim_end().split("\r\n").collect::<Vec<_>>();
    assert_eq!(lines.len(), 1 + 10_001, "header plus every ACTIVE row");
    assert!(!body.contains("Gone"));
    // Spreadsheet formulas stay neutralised.
    assert!(lines[1].starts_with("Test,'=SUM(A1)"), "{}", lines[1]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn both_export_layouts_record_exact_filtered_subjects_from_the_stream_snapshot(pool: PgPool) {
    let t = tenant(&pool).await;
    let included = employee(&pool, t.org, "Included", "IN-1", "ACTIVE").await;
    let excluded = employee(&pool, t.org, "Excluded", "OUT-1", "EXITED").await;
    let reader = user(&pool, t.org, None).await;
    for layout in [None, Some("register")] {
        sqlx::query("UPDATE employees SET name='Included',employment_status='ACTIVE' WHERE id=$1")
            .bind(included)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE employees SET employment_status='EXITED' WHERE id=$1")
            .bind(excluded)
            .execute(&pool)
            .await
            .unwrap();
        let (_, chunks) =
            t.hr.export_employees_csv(
                principal(t.org, reader),
                query(json!({"status":"ACTIVE"})),
                ExportPurposeQuery {
                    export_purpose: Some("INTERNAL_REVIEW".into()),
                    layout: layout.map(str::to_owned),
                },
            )
            .await
            .unwrap();
        // A concurrent change after admission must not change who leaves the system.
        sqlx::query("UPDATE employees SET name='Changed',employment_status='EXITED' WHERE id=$1")
            .bind(included)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE employees SET employment_status='ACTIVE' WHERE id=$1")
            .bind(excluded)
            .execute(&pool)
            .await
            .unwrap();
        let body = chunks
            .map(|chunk| chunk.unwrap())
            .collect::<Vec<_>>()
            .await
            .concat();
        assert!(body.contains("Included"));
        assert!(!body.contains("Excluded"));
        let rows = access_rows(&pool, t.org).await;
        let after = &rows.last().unwrap().2;
        assert_eq!(after["subject_ids"], json!([included]));
        assert_eq!(after["subject_count"], 1);
        assert_eq!(after["export_purpose"], "INTERNAL_REVIEW");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_second_open_exit_case_is_409_naming_the_first_and_cases_are_searchable(pool: PgPool) {
    let t = tenant(&pool).await;
    let kim = employee(&pool, t.org, "Kim Minsu", "K-7", "ACTIVE").await;
    employee(&pool, t.org, "Lee", "L-1", "ACTIVE").await;
    let hr_user = user(&pool, t.org, None).await;
    let report = |key: &str| {
        t.hr.report_exit_case(
            principal(t.org, hr_user),
            key.to_owned(),
            ReportEmployeeExitCaseRequest {
                employee_id: kim,
                branch_id: None,
                absence_alert_id: None,
                effective_exit_date: "2026-10-31".to_owned(),
                site_manager_note: "resigned".to_owned(),
                exit_reason_code: None,
            },
        )
    };
    let (_, first) = report("exit-report-key-0001").await.unwrap();
    let err = report("exit-report-key-0002").await.unwrap_err();
    assert_eq!((err.status.as_u16(), err.code), (409, "exit_case_open"));
    let open = &err.refusals.unwrap()[0];
    assert_eq!(open["case_id"], first["id"]);
    assert_eq!(open["reported_by"], hr_user.as_uuid().to_string());
    assert!(open["reported_at"].is_string());

    let search = |text: &str| {
        let query: ExitCaseListQuery = serde_json::from_value(json!({ "search": text })).unwrap();
        t.hr.list_exit_cases(principal(t.org, hr_user), query)
    };
    for hit in ["minsu", "K-7"] {
        let page = search(hit).await.unwrap();
        assert_eq!(page.total, 1, "{hit}");
    }
    assert_eq!(search("Lee").await.unwrap().total, 0);
}
