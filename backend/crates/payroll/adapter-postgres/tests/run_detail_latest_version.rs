// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use console_kernel_core::OrgId;
use console_payroll_adapter_postgres::PgPayrollStore;
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn run_detail_does_not_leak_v1_line_calculations_alongside_v2(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind("org-ver-check")
    .bind("Ver Org")
    .execute(&pool)
    .await
    .unwrap();

    let run_id: Uuid = sqlx::query_scalar(
        "INSERT INTO payroll_draft_runs \
         (org_id, period_start, period_end, source_label, status) \
         VALUES ($1, $2, $3, 'version-check', 'CALCULATED') RETURNING id",
    )
    .bind(org)
    .bind(date!(2026 - 06 - 01))
    .bind(date!(2026 - 06 - 30))
    .fetch_one(&pool)
    .await
    .unwrap();

    let alice_line: Uuid = sqlx::query_scalar(
        "INSERT INTO payroll_draft_lines \
         (org_id, run_id, employee_source_key, employee_display_name, employee_company) \
         VALUES ($1, $2, 'src-alice', 'Alice', 'SAE') RETURNING id",
    )
    .bind(org)
    .bind(run_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let bob_line: Uuid = sqlx::query_scalar(
        "INSERT INTO payroll_draft_lines \
         (org_id, run_id, employee_source_key, employee_display_name, employee_company) \
         VALUES ($1, $2, 'src-bob', 'Bob', 'SAE') RETURNING id",
    )
    .bind(org)
    .bind(run_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    for (line_id, version, gross_won) in [
        (alice_line, 1, 3_000_000_i64),
        (bob_line, 1, 2_000_000_i64),
        (alice_line, 2, 3_500_000_i64),
    ] {
        sqlx::query(
            "INSERT INTO payroll_line_calculations \
             (org_id, run_id, line_id, version, gross_won, deductions, total_deductions_won, \
              net_won, tax_table_version) \
             VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, 100000, $6, 'v1')",
        )
        .bind(org)
        .bind(run_id)
        .bind(line_id)
        .bind(version)
        .bind(gross_won)
        .bind(gross_won - 100_000)
        .execute(&pool)
        .await
        .unwrap();
    }

    let store = PgPayrollStore::new(runtime_role_pool(&pool).await);
    let detail = console_platform_request_context::scope_org(OrgId::from_uuid(org), async {
        store.get_run(run_id, None, None).await
    })
    .await
    .unwrap()
    .unwrap();

    let calc = detail.calculation.expect("run calc summary present");
    assert_eq!(calc.version, 2);
    assert_eq!(calc.calculated_lines, 1);
    assert_eq!(calc.blocked_lines, 1);
    assert_eq!(calc.total_gross_won, None);

    let alice = detail
        .lines
        .iter()
        .find(|line| line.id == alice_line)
        .unwrap();
    assert_eq!(alice.calculation_version, Some(2));
    assert_eq!(alice.gross_won, Some(3_500_000));

    let bob = detail
        .lines
        .iter()
        .find(|line| line.id == bob_line)
        .unwrap();
    assert_eq!(bob.calculation_version, None);
    assert_eq!(bob.gross_won, None);
    assert!(bob.deductions.is_none());
    assert_eq!(bob.total_deductions_won, None);
    assert_eq!(bob.net_won, None);
    assert_eq!(bob.tax_table_version, None);
}
