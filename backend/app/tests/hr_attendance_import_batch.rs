// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "auth_fixtures/attendance_grants.rs"]
mod attendance_grants;
#[path = "access_log_reads/support.rs"]
mod requests;
mod settings_support;

use console_app::build_router;
use console_kernel_core::{OrgId, UserId};
use console_platform_test_support::seed_active_user;
use http::StatusCode;
use serde_json::{Value, json};
use settings_support::{app_state, keys, runtime_pool, send, token};
use sqlx::PgPool;
use uuid::Uuid;

async fn setup_branch(pool: &PgPool, org: Uuid, name: &str) -> Uuid {
    let region: Uuid = sqlx::query_scalar(
        "INSERT INTO regions(id,name,org_id) VALUES(gen_random_uuid(),$1,$2) RETURNING id",
    )
    .bind(format!("reg-{name}-{}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        "INSERT INTO branches(id,region_id,name,org_id) VALUES(gen_random_uuid(),$1,$2,$3) RETURNING id",
    )
    .bind(region)
    .bind(name)
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn seed_emp(pool: &PgPool, org: Uuid, number: Option<&str>, name: &str, key: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees(org_id,company,employee_number,name,source_filename,source_sheet,source_row,source_key) \
         VALUES($1,'BatchCo',$2,$3,'att.csv','CSV',1,$4) RETURNING id",
    )
    .bind(org)
    .bind(number)
    .bind(name)
    .bind(key)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn upload_csv(service: &axum::Router, bearer: &str, csv: &str) -> (StatusCode, Value) {
    let req = requests::import_preview(bearer, csv);
    requests::send(service, req).await
}

async fn run_import_lifecycle(
    service: &axum::Router,
    bearer: &str,
    csv: &str,
) -> (Value, Value, Value) {
    let (st, preview) = upload_csv(service, bearer, csv).await;
    assert_eq!(st, StatusCode::OK, "{preview}");
    let run_id = preview["run_id"].as_str().unwrap().to_owned();
    let (st, dry) = send(
        service,
        "POST",
        &format!("/api/v1/hr/attendance-import/{run_id}/dry-run"),
        Some(bearer),
        Some(json!({})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{dry}");
    let (st, applied) = send(
        service,
        "POST",
        &format!("/api/v1/hr/attendance-import/{run_id}/apply"),
        Some(bearer),
        Some(json!({"checklist_all_acknowledged":true})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{applied}");
    (preview, dry, applied)
}

async fn table_scans(pool: &PgPool) -> i64 {
    sqlx::query("SELECT pg_stat_force_next_flush()")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(seq_scan + idx_scan), 0)::bigint FROM pg_stat_user_tables \
         WHERE relname IN ('employees','branches','data_import_rows','attendance_direct_import_events')",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn seed_tenant_admin(pool: &PgPool, tag: &str) -> (OrgId, UserId) {
    let org = OrgId::new();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Batch Test Org')")
        .bind(org.as_uuid())
        .bind(org.to_string())
        .execute(pool)
        .await
        .unwrap();
    let actor = seed_active_user(pool, *org.as_uuid(), "SUPER_ADMIN", tag).await;
    (org, actor)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn set_based_attendance_import_has_constant_scan_count_and_validation_parity(pool: PgPool) {
    let (org_small, actor_small) = seed_tenant_admin(&pool, "att-small").await;
    let (org_large, actor_large) = seed_tenant_admin(&pool, "att-large").await;
    attendance_grants::grant(&pool, org_small, actor_small, None).await;
    attendance_grants::grant(&pool, org_large, actor_large, None).await;

    let keys = keys();
    let tok_small = token(
        &pool,
        &keys,
        *org_small.as_uuid(),
        actor_small,
        "SUPER_ADMIN",
    )
    .await;
    let tok_large = token(
        &pool,
        &keys,
        *org_large.as_uuid(),
        actor_large,
        "SUPER_ADMIN",
    )
    .await;
    let service = build_router(app_state(runtime_pool(&pool).await, keys.1.clone()).unwrap());

    setup_branch(&pool, *org_small.as_uuid(), "Seoul").await;
    setup_branch(&pool, *org_large.as_uuid(), "Seoul").await;

    let mut small_csv = String::from(
        "employee_number,employee_name,branch_name,work_date,check_in,check_out,minutes_worked\n",
    );
    for i in 0..4 {
        let num = format!("S{i:03}");
        let name = format!("SmallEmp{i}");
        seed_emp(&pool, *org_small.as_uuid(), Some(&num), &name, &num).await;
        small_csv.push_str(&format!("{num},{name},Seoul,2026-08-01,09:00,18:00,540\n"));
    }

    let mut large_csv = String::from(
        "employee_number,employee_name,branch_name,work_date,check_in,check_out,minutes_worked\n",
    );
    for i in 0..60 {
        let num = format!("L{i:03}");
        let name = format!("LargeEmp{i}");
        seed_emp(&pool, *org_large.as_uuid(), Some(&num), &name, &num).await;
        large_csv.push_str(&format!("{num},{name},Seoul,2026-08-01,09:00,18:00,540\n"));
    }

    sqlx::query("SELECT pg_stat_reset()")
        .execute(&pool)
        .await
        .unwrap();
    let (_, dry_small, app_small) = run_import_lifecycle(&service, &tok_small, &small_csv).await;
    assert_eq!(dry_small["ready_rows"], 4);
    assert_eq!(app_small["inserted"], 4);
    let scans_small = table_scans(&pool).await;

    sqlx::query("SELECT pg_stat_reset()")
        .execute(&pool)
        .await
        .unwrap();
    let (_, dry_large, app_large) = run_import_lifecycle(&service, &tok_large, &large_csv).await;
    assert_eq!(dry_large["ready_rows"], 60);
    assert_eq!(app_large["inserted"], 60);
    let scans_large = table_scans(&pool).await;

    assert!(
        scans_large <= scans_small + 2 && scans_large < 30,
        "scans must remain O(1) independent of row count (4 rows={scans_small}, 60 rows={scans_large})"
    );

    // Validation parity: missing/ambiguous employee, missing/ambiguous branch, in-file dup, existing dup.
    let (parity_org, parity_actor) = seed_tenant_admin(&pool, "att-parity").await;
    attendance_grants::grant(&pool, parity_org, parity_actor, None).await;
    let tok_parity = token(
        &pool,
        &keys,
        *parity_org.as_uuid(),
        parity_actor,
        "SUPER_ADMIN",
    )
    .await;
    setup_branch(&pool, *parity_org.as_uuid(), "HQ").await;
    setup_branch(&pool, *parity_org.as_uuid(), "DupBranch").await;
    setup_branch(&pool, *parity_org.as_uuid(), "DupBranch").await;
    seed_emp(&pool, *parity_org.as_uuid(), Some("K001"), "Kim", "k1").await;
    seed_emp(&pool, *parity_org.as_uuid(), None, "DupName", "d1").await;
    seed_emp(&pool, *parity_org.as_uuid(), None, "DupName", "d2").await;

    let parity_csv = concat!(
        "employee_number,employee_name,branch_name,work_date,check_in,check_out,minutes_worked\n",
        "K001,Kim,HQ,2026-08-02,09:00,18:00,540\n",
        ",Kim,HQ,2026-08-02,09:00,18:00,540\n",
        ",MissingEmp,HQ,2026-08-02,09:00,18:00,540\n",
        ",DupName,HQ,2026-08-02,09:00,18:00,540\n",
        "K001,Kim,NoBranch,2026-08-02,09:00,18:00,540\n",
        "K001,Kim,DupBranch,2026-08-02,09:00,18:00,540\n"
    );
    let (st, preview) = upload_csv(&service, &tok_parity, parity_csv).await;
    assert_eq!(st, StatusCode::OK, "{preview}");
    let run_id = preview["run_id"].as_str().unwrap();
    let (st, dry) = send(
        &service,
        "POST",
        &format!("/api/v1/hr/attendance-import/{run_id}/dry-run"),
        Some(&tok_parity),
        Some(json!({})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{dry}");
    assert_eq!(dry["ready_rows"], 1, "{dry}");
    assert_eq!(dry["error_rows"], 5);
    assert_eq!(dry["missing_employee_rows"], 1);
    assert_eq!(dry["ambiguous_employee_rows"], 1);
    let codes: Vec<&str> = dry["row_errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["code"].as_str().unwrap())
        .collect();
    assert_eq!(
        codes,
        vec![
            "duplicate_attendance_fact_in_file",
            "missing_employee",
            "ambiguous_employee",
            "missing_branch",
            "ambiguous_branch",
        ]
    );
}
