// SPDX-License-Identifier: LicenseRef-Proprietary
//! The employee CSV export keeps to the reader's grants: its rows are the
//! export reach, and the register layout also the edit reach.
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

use crate::support::{self, Ctx};
use crate::world::world;

/// The employee numbers in one CSV export, in file order.
async fn exported_numbers(ctx: &Ctx, layout: &str) -> Vec<String> {
    use axum::body::{Body, to_bytes};
    use tower::ServiceExt;
    let uri =
        format!("/api/v1/employees/export.csv?layout={layout}&export_purpose=INTERNAL_REVIEW");
    let request = http::Request::get(uri)
        .header(http::header::AUTHORIZATION, format!("Bearer {}", ctx.token))
        .body(Body::empty())
        .unwrap();
    let response = ctx.service.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert_eq!(status, StatusCode::OK, "{layout}: {body}");
    let column = if layout == "register" { 0 } else { 2 };
    body.trim_end()
        .split("\r\n")
        .skip(1)
        .map(|row| row.split(',').nth(column).unwrap().to_owned())
        .collect()
}

/// The register layout carries columns only an editor reads, so its rows are
/// the people the reader both exports and edits, whatever the export reach.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_register_export_stays_within_the_edit_scope(pool: PgPool) {
    let mut w = world(pool).await;
    let export = w
        .role(
            "Register download",
            json!([{ "domain": "hr_basic", "levels": ["export"] }]),
        )
        .await;
    let edit = w
        .role(
            "Personnel edit",
            json!([{ "domain": "hr_basic", "levels": ["edit"] }]),
        )
        .await;
    let user = support::add_user(&w.pool, w.org, &[]).await;
    let dept = w.dept_x.clone();
    w.grant(user, &export, "TENANT", None).await;
    w.grant(user, &edit, "DEPARTMENT", Some(&dept)).await;
    let reader = support::ctx(&w.pool, w.org, user, &[], None).await;

    let mut standard = exported_numbers(&reader, "standard").await;
    standard.sort();
    assert_eq!(
        standard,
        ["A-001", "A-002", "B-001"],
        "export reaches the tenant"
    );
    assert_eq!(exported_numbers(&reader, "register").await, ["A-001"]);
}

/// The section sheet is a download of the whole tenant, so it takes the
/// tenant-wide export level as well as the edit level.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_section_sheet_takes_the_export_level(pool: PgPool) {
    let mut w = world(pool).await;
    let editor = w.holder("TENANT", None).await;
    let uri = "/api/v1/employee-records/family?export_purpose=INTERNAL_REVIEW";
    let (status, body) = editor.call("GET", uri, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "edit alone: {body}");
    assert_eq!(support::count(&w.pool, "excel_export_logs", w.org).await, 0);

    let export = w
        .role(
            "Register download",
            json!([{ "domain": "hr_basic", "levels": ["export"] }]),
        )
        .await;
    w.grant(editor.user, &export, "TENANT", None).await;
    let (status, body) = editor.call("GET", uri, None).await;
    assert_eq!(status, StatusCode::OK, "edit and export: {body}");
    assert_eq!(support::count(&w.pool, "excel_export_logs", w.org).await, 1);
}
