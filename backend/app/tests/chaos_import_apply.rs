#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! TS-15 for the roster import: apply is cut mid-transaction (inside the
//! batch, inside the settle that follows it, and by an outside terminate of a
//! long batch — a database restart as the app sees it). Nothing is half
//! applied, and re-applying the same dry run finishes it exactly once.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/chaos.rs"]
mod chaos;
#[path = "support/http.rs"]
mod support;
use chaos::{arm_kill, arm_slow, disarm, kill_running};
use support::{Ctx, audits, count, ctx, structure, tenant};

const ADMIN: &[&str] = &["SUPER_ADMIN"];
const ROWS: usize = 5;

fn roster() -> Vec<u8> {
    let mut book = umya_spreadsheet::new_file();
    let sheet = book.sheet_by_name_mut("Sheet1").unwrap();
    for (col, header) in ["성명", "사번", "입사일"].iter().enumerate() {
        sheet.cell_mut((col as u32 + 1, 1)).set_value(*header);
    }
    for row in 0..ROWS {
        let r = row as u32 + 2;
        sheet.cell_mut((1, r)).set_value(format!("가져온{row}"));
        sheet.cell_mut((2, r)).set_value(format!("IM-{row:03}"));
        sheet.cell_mut((3, r)).set_value("2026-01-02");
    }
    let mut out = Vec::new();
    umya_spreadsheet::writer::xlsx::write_writer(&book, &mut out).unwrap();
    out
}

/// Preview + dry run; returns (apply URI, apply body).
async fn dry_run(ctx: &Ctx) -> (String, Value) {
    let boundary = "chaosboundary";
    let mut body = Vec::new();
    for (name, value) in [
        ("pay_period_start", "2026-01-01"),
        ("pay_period_end", "2026-01-31"),
    ] {
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .into_bytes(),
        );
    }
    body.extend(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"명부.xlsx\"\r\n\
             Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n"
        )
        .into_bytes(),
    );
    body.extend(roster());
    body.extend(format!("\r\n--{boundary}--\r\n").into_bytes());
    let content = format!("multipart/form-data; boundary={boundary}");
    let (status, preview) = ctx
        .raw(
            "POST",
            "/api/v1/employees/import/preview",
            &content,
            Some(body),
            Some(Uuid::new_v4()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let run = preview["run_id"].as_str().unwrap().to_owned();
    let (status, summary) = ctx
        .call(
            "POST",
            &format!("/api/v1/employees/import/{run}/dry-run"),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    (
        format!("/api/v1/employees/import/{run}/apply"),
        json!({ "dry_run_digest": summary["dry_run_digest"] }),
    )
}

async fn run_status(pool: &PgPool, org: Uuid) -> String {
    sqlx::query_scalar(
        "SELECT status FROM data_import_runs WHERE org_id = $1 AND entity_type = 'employee_hr'",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn setup(pool: &PgPool) -> (Uuid, Ctx, String, Value) {
    let (org, user) = tenant(pool, ADMIN).await;
    let ctx = ctx(pool, org, user, ADMIN, None).await;
    structure(&ctx).await;
    let (apply, body) = dry_run(&ctx).await;
    (org, ctx, apply, body)
}

/// Re-applies until done; the run ends APPLIED with ROWS people, once.
async fn finishes_once(pool: &PgPool, org: Uuid, ctx: &Ctx, apply: &str, body: &Value) {
    let (status, report) = ctx.call("POST", apply, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    let (status, replay) = ctx.call("POST", apply, Some(body.clone())).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a replay returns the stored report: {replay}"
    );
    assert_eq!(replay["inserted"], report["inserted"]);
    assert_eq!(run_status(pool, org).await, "APPLIED");
    assert_eq!(count(pool, "employees", org).await, ROWS as i64);
    assert_eq!(
        audits(pool, org, "employee.import.settle").await,
        1,
        "settled once"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn apply_killed_inside_the_batch_writes_nothing_and_reapplies_once(pool: PgPool) {
    let (org, ctx, apply, body) = setup(&pool).await;
    arm_kill(&pool, "employees", "AFTER INSERT", "true").await;
    let (status, died) = ctx.call("POST", &apply, Some(body.clone())).await;
    assert!(status.is_server_error(), "{status} {died}");
    assert_eq!(count(&pool, "employees", org).await, 0, "no half write");
    assert_eq!(run_status(&pool, org).await, "DRY_RUN");
    disarm(&pool).await;
    finishes_once(&pool, org, &ctx, &apply, &body).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn apply_killed_in_the_settle_is_finished_by_the_reapply(pool: PgPool) {
    let (org, ctx, apply, body) = setup(&pool).await;
    arm_kill(
        &pool,
        "audit_events",
        "AFTER INSERT",
        "NEW.action = 'employee.import.settle'",
    )
    .await;
    let (status, died) = ctx.call("POST", &apply, Some(body.clone())).await;
    assert!(status.is_server_error(), "{status} {died}");
    assert_eq!(audits(&pool, org, "employee.import.settle").await, 0);
    disarm(&pool).await;
    finishes_once(&pool, org, &ctx, &apply, &body).await;
}

/// A long batch terminated from outside (what a restart does to the app's
/// connection): nothing of it stays, and the reapply finishes the run.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn apply_terminated_from_outside_mid_batch_writes_nothing_and_reapplies_once(pool: PgPool) {
    let (org, ctx, apply, body) = setup(&pool).await;
    arm_slow(&pool, "employees", "AFTER INSERT", "true", 0.5).await;
    let killer = async {
        for _ in 0..200 {
            if kill_running(&pool, "apply_employee_import_batch").await > 0 {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        false
    };
    let ((status, died), killed) =
        tokio::join!(ctx.call("POST", &apply, Some(body.clone())), killer);
    assert!(killed, "the batch never showed up in pg_stat_activity");
    assert!(status.is_server_error(), "{status} {died}");
    assert_eq!(count(&pool, "employees", org).await, 0, "no half write");
    assert_eq!(run_status(&pool, org).await, "DRY_RUN");
    disarm(&pool).await;
    finishes_once(&pool, org, &ctx, &apply, &body).await;
}
