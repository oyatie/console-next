// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[allow(dead_code)]
#[path = "roster_materialisation/seed.rs"]
mod roster_seed;

use console_kernel_core::OrgId;
use console_payroll_adapter_postgres::lifecycle::{calculate_run_in_tx, close_attendance_in_tx};
use console_payroll_adapter_postgres::roster::materialise_roster_in_tx;
use console_payroll_adapter_postgres::{PgPayrollError, get_run_filtered_in_tx};
use console_platform_db::with_org_conn;
use console_platform_test_support::runtime_role_pool;
use serde_json::json;
use sqlx::PgPool;
use time::OffsetDateTime;
use time::macros::date;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn runtime_role_inserts_new_breakdown_columns_and_cannot_update_them(pool: PgPool) {
    let rt_pool = runtime_role_pool(&pool).await;
    sqlx::query(
        "INSERT INTO payroll_line_calculations \
         (org_id, version, base_pay_won, overtime_pay_won, meal_allowance_won, taxable_won) \
         SELECT NULL, 1, 1000, 200, 100, 1100 WHERE FALSE",
    )
    .execute(&rt_pool)
    .await
    .expect("console_rt must retain INSERT of the 4 breakdown columns");

    for stmt in [
        "UPDATE payroll_line_calculations SET base_pay_won = 1 WHERE FALSE",
        "UPDATE payroll_line_calculations SET overtime_pay_won = 1 WHERE FALSE",
        "UPDATE payroll_line_calculations SET meal_allowance_won = 1 WHERE FALSE",
        "UPDATE payroll_line_calculations SET taxable_won = 1 WHERE FALSE",
        "DELETE FROM payroll_line_calculations WHERE FALSE",
    ] {
        let err = sqlx::query(stmt)
            .execute(&rt_pool)
            .await
            .expect_err("console_rt must not update/delete breakdown columns");
        let code = err
            .as_database_error()
            .and_then(|db| db.code())
            .map(|c| c.into_owned())
            .unwrap_or_default();
        assert_eq!(code, "42501", "expected insufficient_privilege: {err}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bank_flag_search_breakdown_and_invalid_amounts_work_with_rls(pool: PgPool) {
    let org_a = OrgId::new();
    let org_b = OrgId::new();
    for (org, slug) in [(org_a, "pay-a"), (org_b, "pay-b")] {
        sqlx::query(
            "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
        )
        .bind(org.as_uuid())
        .bind(slug)
        .bind(slug)
        .execute(&pool)
        .await
        .unwrap();
    }
    let actor = Uuid::new_v4();
    let emp_ok = Uuid::new_v4();
    let emp_missing_bank = Uuid::new_v4();
    let emp_bad_src = Uuid::new_v4();

    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, 'HR', $2, $3)")
        .bind(actor)
        .bind(["ADMIN"].as_slice())
        .bind(org_a.as_uuid())
        .execute(&pool)
        .await
        .unwrap();

    for (emp_id, num, name, registered) in [
        (emp_ok, "E-101", "Alice", true),
        (emp_missing_bank, "E-102", "Bob", false),
        (emp_bad_src, "E-103", "Charlie", false),
    ] {
        sqlx::query(
            "INSERT INTO employees (id, org_id, company, name, position, employee_number, hire_date, hire_on, employment_status, source_filename, source_sheet, source_row, source_key) \
             VALUES ($1, $2, 'TestCo', $3, 'Manager', $4, '2025-01-01', '2025-01-01', 'ACTIVE', 'f', 's', 1, $1::text)",
        )
        .bind(emp_id)
        .bind(org_a.as_uuid())
        .bind(name)
        .bind(num)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO employee_personal_facts (org_id, employee_id, bank_account_registered) \
             VALUES ($1, $2, $3)",
        )
        .bind(org_a.as_uuid())
        .bind(emp_id)
        .bind(registered)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason) \
         VALUES ($1, 'payroll', $2, $3, 'lock')",
    )
    .bind(org_a.as_uuid())
    .bind(date!(2026 - 06 - 01))
    .bind(date!(2026 - 06 - 30))
    .execute(&pool)
    .await
    .unwrap();

    let import_run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO data_import_runs \
         (id, org_id, entity_type, source_filename, source_format, source_sha256, status, pay_period_start, pay_period_end, mapping_profile, created_by) \
         VALUES ($1, $2, 'employee_hr', 'pay.xlsx', 'xlsx', repeat('a', 64), 'DRY_RUN', $3, $4, '{}'::jsonb, $5)",
    )
    .bind(import_run)
    .bind(org_a.as_uuid())
    .bind(date!(2026 - 06 - 01))
    .bind(date!(2026 - 06 - 30))
    .bind(actor)
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE data_import_runs SET status = 'APPLIED' WHERE id = $1")
        .bind(import_run)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let ok_payload = json!({
        "source_key": emp_ok.to_string(),
        "payroll": {
            "monthly_gross_pay_won": 3_000_000,
            "base_pay_won": 2_600_000,
            "overtime_pay_won": 200_000,
            "meal_allowance_won": 200_000,
            "nts_tax_row": { "table_version": "2026", "monthly_income_tax_won": 80_000, "local_income_tax_won": 8_000 }
        }
    });
    let missing_bank_payload = json!({ "source_key": emp_missing_bank.to_string() });
    let bad_payload = json!({
        "source_key": emp_bad_src.to_string(),
        "payroll": {
            "monthly_gross_pay_won": 2_500_000,
            "meal_allowance_won": -100,
            "nts_tax_row": { "table_version": "2026", "monthly_income_tax_won": 40_000, "local_income_tax_won": 4_000 }
        }
    });
    let raw = roster_seed::attendance_row();
    for (idx, (eid, canon)) in [
        (emp_ok, ok_payload),
        (emp_missing_bank, missing_bank_payload),
        (emp_bad_src, bad_payload),
    ]
    .into_iter()
    .enumerate()
    {
        sqlx::query(
            "INSERT INTO data_import_rows (id, org_id, run_id, source_sheet, source_row, source_key, row_status, raw_row, canonical_row) \
             VALUES (gen_random_uuid(), $1, $2, 'S1', $3, $4, 'CANDIDATE', $5, $6)",
        )
        .bind(org_a.as_uuid())
        .bind(import_run)
        .bind(i32::try_from(idx + 1).unwrap())
        .bind(format!("k-{eid}"))
        .bind(&raw)
        .bind(canon)
        .execute(&pool)
        .await
        .unwrap();
    }

    let run_id: Uuid = sqlx::query_scalar(
        "INSERT INTO payroll_draft_runs (org_id, period_start, period_end, source_label, status) \
         VALUES ($1, '2026-06-01', '2026-06-30', 'roster-bank', 'BLOCKED_LEGAL_GATE') RETURNING id",
    )
    .bind(org_a.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();

    let rt_pool = runtime_role_pool(&pool).await;
    with_org_conn::<_, (), PgPayrollError>(&rt_pool, org_a, move |tx| {
        Box::pin(async move {
            let count = materialise_roster_in_tx(
                tx,
                *org_a.as_uuid(),
                run_id,
                date!(2026 - 06 - 01),
                date!(2026 - 06 - 30),
            )
            .await?;
            assert_eq!(count, 3);
            Ok(())
        })
    })
    .await
    .unwrap();

    sqlx::query(
        "UPDATE payroll_draft_lines SET nts_tax_row_status = 'VERIFIED_SOURCE_ROW', gross_pay_source_present = TRUE WHERE run_id = $1 AND employee_id IN ($2, $3)",
    )
    .bind(run_id)
    .bind(emp_ok)
    .bind(emp_bad_src)
    .execute(&pool)
    .await
    .unwrap();

    with_org_conn::<_, (), PgPayrollError>(&rt_pool, org_a, move |tx| {
        Box::pin(async move {
            close_attendance_in_tx(tx, run_id, actor, OffsetDateTime::now_utc())
                .await
                .unwrap();
            let calc = calculate_run_in_tx(tx, run_id).await.unwrap();
            let detail = get_run_filtered_in_tx(tx, run_id, None, None, false, None)
                .await?
                .unwrap();
            assert_eq!(calc.calculated_lines, 1, "lines={:?}", detail.lines);
            assert_eq!(calc.blocked_lines, 2, "lines={:?}", detail.lines);
            assert_eq!(detail.missing_bank_account_count, 2);
            let ok_line = detail
                .lines
                .iter()
                .find(|l| l.employee_id == Some(emp_ok))
                .unwrap();
            assert!(ok_line.bank_account_registered);
            assert_eq!(ok_line.base_pay_won, Some(2_600_000));
            assert_eq!(ok_line.overtime_pay_won, Some(200_000));
            assert_eq!(ok_line.meal_allowance_won, Some(200_000));
            assert_eq!(ok_line.taxable_won, Some(2_800_000));

            let bad_line = detail
                .lines
                .iter()
                .find(|l| l.employee_id == Some(emp_bad_src))
                .unwrap();
            assert_eq!(bad_line.calculation_status, "BLOCKED_LEGAL_GATE");
            assert!(
                bad_line
                    .blockers
                    .to_string()
                    .contains("SOURCE_AMOUNTS_INVALID"),
                "{}",
                bad_line.blockers
            );

            let filtered = get_run_filtered_in_tx(tx, run_id, None, None, true, Some("E-102"))
                .await?
                .unwrap();
            assert_eq!(filtered.missing_bank_account_count, 2);
            assert_eq!(filtered.lines_total, 1);
            assert_eq!(filtered.lines[0].employee_id, Some(emp_missing_bank));
            Ok(())
        })
    })
    .await
    .unwrap();

    let foreign = with_org_conn::<_, _, PgPayrollError>(&rt_pool, org_b, move |tx| {
        Box::pin(async move { get_run_filtered_in_tx(tx, run_id, None, None, false, None).await })
    })
    .await
    .unwrap();
    assert!(foreign.is_none());
}
