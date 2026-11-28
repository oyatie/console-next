#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! §16 ingest-commit gate (ruling 85, BE-ingest-checklist-gates) —
//! `POST /api/v1/hr/attendance-import/{run_id}/apply` ("load"/commit) over the
//! REAL router on a genuine non-owner `console_rt` pool (RLS enforced), JWT-authed.
//!
//! Proves:
//!   * apply WITHOUT `checklist_all_acknowledged` (or with `false`) denies
//!     (403) BEFORE the run row is even read — fail-closed, zero rows written,
//!     the run stays `DRY_RUN`;
//!   * apply WITH `checklist_all_acknowledged: true` passes the gate and the
//!     real mutation runs (run flips to `APPLIED`), and the audit trail carries
//!     the gate outcome.

use console_app::build_router;
use console_kernel_core::OrgId;
use console_platform_test_support::{seed_active_user, seed_branch};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "auth_fixtures/attendance_grants.rs"]
mod attendance_grants;
#[path = "access_log_reads/support.rs"]
mod requests;
mod settings_support;
use settings_support::{app_state, keys, runtime_pool, send, token};

// ===========================================================================
// Deny path: no checklist evidence ⇒ 403, before the run row is even touched.
// Nothing is written — the run (seeded DRY_RUN) is untouched, zero events.
// ===========================================================================
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn apply_without_checklist_denies_and_writes_nothing(owner_pool: PgPool) {
    let (service, bearer, run_id) = ready_dry_run(&owner_pool, "checklist-deny").await;

    // No body at all (no Content-Type ⇒ `checklist_all_acknowledged: None`).
    let (status, denied) = send(
        &service,
        "POST",
        &format!("/api/v1/hr/attendance-import/{run_id}/apply"),
        Some(&bearer),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    assert!(
        denied["error"]["message"]
            .as_str()
            .unwrap()
            .contains("checklist"),
        "must deny for the checklist gate specifically, not some other 403: {:?}",
        denied
    );

    // Explicit `false` must deny identically (not just "missing").
    let (status, denied_explicit) = send(
        &service,
        "POST",
        &format!("/api/v1/hr/attendance-import/{run_id}/apply"),
        Some(&bearer),
        Some(json!({ "checklist_all_acknowledged": false })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{:?}", denied_explicit);

    let status: String = sqlx::query_scalar("SELECT status FROM data_import_runs WHERE id = $1")
        .bind(run_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(status, "DRY_RUN", "a denied gate must not flip the run");
    let events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM attendance_direct_import_events WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(events, 0, "a denied gate must write zero rows");
}

// ===========================================================================
// Allow path: checklist acknowledged ⇒ the real mutation runs (run flips to
// APPLIED) and the audit event carries the gate outcome.
// ===========================================================================
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn apply_with_checklist_admits_and_applies(owner_pool: PgPool) {
    let (service, bearer, run_id) = ready_dry_run(&owner_pool, "checklist-allow").await;

    let (status, applied) = send(
        &service,
        "POST",
        &format!("/api/v1/hr/attendance-import/{run_id}/apply"),
        Some(&bearer),
        Some(json!({ "checklist_all_acknowledged": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["inserted"], 1);
    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM attendance_direct_import_events WHERE run_id=$1")
            .bind(run_id)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(events, 1);

    let status: String = sqlx::query_scalar("SELECT status FROM data_import_runs WHERE id = $1")
        .bind(run_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
    assert_eq!(status, "APPLIED", "an admitted gate must apply the run");

    let gate_outcome: Value = sqlx::query_scalar(
        "SELECT after_snap -> 'gate_outcome' FROM audit_events \
         WHERE action = 'attendance_import.apply' AND target_type = 'data_import_run' AND target_id = $1 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(run_id.to_string())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(
        gate_outcome["allow"],
        Value::Bool(true),
        "the audit row must carry the passing gate outcome: {gate_outcome:?}"
    );
}

/// Preview and resolve the same valid input for both sides of the checklist gate.
async fn ready_dry_run(pool: &PgPool, tag: &str) -> (axum::Router, String, Uuid) {
    let org = OrgId::one();
    let admin = seed_active_user(pool, *org.as_uuid(), "SUPER_ADMIN", tag).await;
    attendance_grants::grant(pool, org, admin, None).await;
    let branch = seed_branch(pool, tag, tag).await;
    let branch_name: String = sqlx::query_scalar("SELECT name FROM branches WHERE id=$1")
        .bind(branch.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employees(org_id,company,employee_number,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'Checklist','E001','Worker','roster.csv','CSV',1,'E001')")
        .bind(org.as_uuid()).execute(pool).await.unwrap();
    let keys = keys();
    let bearer = token(pool, &keys, *org.as_uuid(), admin, "SUPER_ADMIN").await;
    let service = build_router(app_state(runtime_pool(pool).await, keys.1).unwrap());
    let csv = format!(
        "employee_number,branch_name,work_date,check_in,check_out,minutes_worked\nE001,{branch_name},2026-06-01,09:00,18:00,540\n"
    );
    let (status, preview) = requests::send(&service, requests::import_preview(&bearer, &csv)).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let run_id: Uuid = serde_json::from_value(preview["run_id"].clone()).unwrap();
    let (status, dry) = send(
        &service,
        "POST",
        &format!("/api/v1/hr/attendance-import/{run_id}/dry-run"),
        Some(&bearer),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{dry}");
    assert_eq!(dry["ready_rows"], 1, "{dry}");
    (service, bearer, run_id)
}
