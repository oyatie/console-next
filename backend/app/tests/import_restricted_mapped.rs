// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

#[allow(dead_code)]
#[path = "emp_ui_routes/harness.rs"]
mod harness;

fn workbook_bytes() -> Vec<u8> {
    use console_hr_domain::import::classification::employee_import_field_for_target;
    let mut book = umya_spreadsheet::new_file();
    let sheet = book.sheet_by_name_mut("Sheet1").unwrap();
    let headers = [
        employee_import_field_for_target("name").unwrap().aliases[0],
        "account_no",
        "salary",
        employee_import_field_for_target("phone").unwrap().aliases[0],
    ];
    let row = ["Kim HTTP", "999-111-222333", "6200000", "010-8888-7777"];
    for (col, val) in headers.iter().enumerate() {
        sheet.cell_mut((col as u32 + 1, 1)).set_value(*val);
    }
    for (col, val) in row.iter().enumerate() {
        sheet.cell_mut((col as u32 + 1, 2)).set_value(*val);
    }
    let mut out = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&book, &mut out).unwrap();
    out
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preview_rejects_restricted_column_remap_with_422_and_writes_nothing(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Import Restrict')")
        .bind(org)
        .bind(format!("restrict-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let keys = harness::keys();
    let actor = harness::user(&pool, org, "SUPER_ADMIN").await;
    let token = harness::token(&pool, &keys, org, actor, "SUPER_ADMIN").await;
    let app = harness::router(&pool, &keys).await;

    let bytes = workbook_bytes();
    let mapping = json!({
        "sheets": {
            "Sheet1": {
                "header_row": 1,
                "columns": {
                    "A": "name",
                    "B": "position",
                    "C": "job",
                    "D": "worksite_name"
                },
                "skip": false
            }
        }
    })
    .to_string();

    let boundary = "m4restrictboundary";
    let mut body = Vec::new();
    body.extend(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"mapping\"\r\n\r\n{mapping}\r\n"
        )
        .into_bytes(),
    );
    body.extend(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"roster.xlsx\"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n"
        )
        .into_bytes(),
    );
    body.extend_from_slice(&bytes);
    body.extend(format!("\r\n--{boundary}--\r\n").into_bytes());

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/employees/import/preview")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .header("Idempotency-Key", Uuid::new_v4().to_string())
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let resp_bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let err: Value = serde_json::from_slice(&resp_bytes).unwrap();
    assert_eq!(err["error"]["code"], "mapping_restricted_column", "{err}");
    let serialized = err.to_string();
    assert!(!serialized.contains("999-111-222333"));
    assert!(!serialized.contains("6200000"));
    assert!(!serialized.contains("010-8888-7777"));

    let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM data_import_runs WHERE org_id = $1")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM data_import_rows WHERE org_id = $1")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    let emps: i64 = sqlx::query_scalar("SELECT count(*) FROM employees WHERE org_id = $1")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((runs, rows, emps), (0, 0, 0));
}
