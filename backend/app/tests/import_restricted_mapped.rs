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

fn multipart_preview_body(boundary: &str, mapping: &str, bytes: &[u8]) -> Vec<u8> {
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
    body.extend_from_slice(bytes);
    body.extend(format!("\r\n--{boundary}--\r\n").into_bytes());
    body
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preview_rejects_punctuation_split_restricted_headers_and_allows_worksite_address(
    pool: PgPool,
) {
    use console_hr_domain::import::classification::employee_import_field_for_target;
    let ko = |cps: &[u32]| -> String {
        cps.iter()
            .map(|&c| char::from_u32(c).unwrap())
            .collect::<String>()
    };
    let name_header = employee_import_field_for_target("name").unwrap().aliases[0];
    let worksite_addr_header = employee_import_field_for_target("worksite_address")
        .unwrap()
        .aliases[1];
    assert_eq!(
        worksite_addr_header,
        ko(&[0xADFC, 0xBB34, 0xC9C0, 0xC8FC, 0xC18C])
    );

    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Import Punctuation')")
        .bind(org)
        .bind(format!("punct-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let keys = harness::keys();
    let actor = harness::user(&pool, org, "SUPER_ADMIN").await;
    let token = harness::token(&pool, &keys, org, actor, "SUPER_ADMIN").await;
    let app = harness::router(&pool, &keys).await;

    let cases = [
        (ko(&[0xAC1C, 0xC778, 0x5F, 0xC8FC, 0xC18C]), "worksite_name"),
        (ko(&[0xAC70, 0xC8FC, 0x5F, 0xC8FC, 0xC18C]), "worksite_name"),
        (ko(&[0xAC1C, 0xC778, 0x2D, 0xC8FC, 0xC18C]), "position"),
        (ko(&[0x5B, 0xC8FC, 0xC18C, 0x5D]), "worksite_name"),
        (
            ko(&[0xC8FC, 0xC18C, 0x28, 0xAC1C, 0xC778, 0x29]),
            "worksite_name",
        ),
        (
            ko(&[0xD578, 0xB4DC, 0x5F, 0xD3F0, 0x28, 0xBE44, 0xC0C1, 0x29]),
            "position",
        ),
        (
            ko(&[0xC5F0, 0xB77D, 0x5F, 0xCC98, 0x28, 0xAC1C, 0xC778, 0x29]),
            "job",
        ),
    ];

    for (idx, (restricted_header, target)) in cases.iter().enumerate() {
        let mut book = umya_spreadsheet::new_file();
        let sheet = book.sheet_by_name_mut("Sheet1").unwrap();
        let sentinel = format!("PII_SENTINEL_{idx}");
        sheet.cell_mut((1, 1)).set_value(name_header);
        sheet.cell_mut((2, 1)).set_value(restricted_header.as_str());
        sheet.cell_mut((1, 2)).set_value("Kim Test");
        sheet.cell_mut((2, 2)).set_value(&sentinel);
        let mut bytes = Vec::new();
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut bytes).unwrap();

        let mapping = json!({
            "sheets": {
                "Sheet1": {
                    "header_row": 1,
                    "columns": { "A": "name", "B": target },
                    "skip": false
                }
            }
        })
        .to_string();
        let boundary = format!("m4punct{idx}");
        let body = multipart_preview_body(&boundary, &mapping, &bytes);

        let response = app
            .clone()
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

        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "expected 422 for {restricted_header} -> {target}"
        );
        let resp_bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let err: Value = serde_json::from_slice(&resp_bytes).unwrap();
        assert_eq!(err["error"]["code"], "mapping_restricted_column", "{err}");
        assert!(!err.to_string().contains(&sentinel));
    }

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

    // Valid worksite_address alias still succeeds.
    let mut ok_book = umya_spreadsheet::new_file();
    let ok_sheet = ok_book.sheet_by_name_mut("Sheet1").unwrap();
    ok_sheet.cell_mut((1, 1)).set_value(name_header);
    ok_sheet.cell_mut((2, 1)).set_value(worksite_addr_header);
    ok_sheet.cell_mut((1, 2)).set_value("Kim Valid");
    ok_sheet.cell_mut((2, 2)).set_value("Plant 1 Road");
    let mut ok_bytes = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&ok_book, &mut ok_bytes).unwrap();

    let ok_mapping = json!({
        "sheets": {
            "Sheet1": {
                "header_row": 1,
                "columns": { "A": "name", "B": "worksite_address" },
                "skip": false
            }
        }
    })
    .to_string();
    let ok_body = multipart_preview_body("m4punctok", &ok_mapping, &ok_bytes);
    let ok_resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/employees/import/preview")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(
                    header::CONTENT_TYPE,
                    "multipart/form-data; boundary=m4punctok",
                )
                .header("Idempotency-Key", Uuid::new_v4().to_string())
                .body(Body::from(ok_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ok_resp.status(), StatusCode::OK);
}
