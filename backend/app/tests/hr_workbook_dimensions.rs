// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use axum::body::{Body, to_bytes};
use http::{Request, StatusCode, header};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

#[allow(dead_code)]
#[path = "emp_ui_routes/harness.rs"]
mod harness;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reversed_dimensions_are_refused_without_creating_an_import_run(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'Workbook validation')")
        .bind(org)
        .bind(format!("workbook-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    let keys = harness::keys();
    let actor = harness::user(&pool, org, "SUPER_ADMIN").await;
    let token = harness::token(&pool, &keys, org, actor, "SUPER_ADMIN").await;
    let app = harness::router(&pool, &keys).await;
    let mut body = b"--workbook\r\nContent-Disposition: form-data; name=\"file\"; filename=\"roster.xlsx\"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n".to_vec();
    body.extend_from_slice(include_bytes!(
        "../../fuzz/regressions/fz5-reversed-dimension.xlsx"
    ));
    body.extend_from_slice(b"\r\n--workbook--\r\n");
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/employees/import/preview")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(
                    header::CONTENT_TYPE,
                    "multipart/form-data; boundary=workbook",
                )
                .header("Idempotency-Key", Uuid::new_v4().to_string())
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let error: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(error["error"]["code"], "workbook_corrupt");
    let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM data_import_runs WHERE org_id=$1")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(runs, 0);
}
