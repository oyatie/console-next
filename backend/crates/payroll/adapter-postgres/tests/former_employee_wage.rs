// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Ordinary wage writes use the same employee-state boundary as personnel records.
use console_kernel_core::{KernelError, OrgId};
use console_payroll_adapter_postgres::{
    PgPayrollError,
    payslip_draft::{NewContractWage, insert_contract_wage_in_tx},
};
use console_platform_db::with_audits;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

async fn record(pool: &PgPool, org: OrgId, wage: NewContractWage) -> Result<Uuid, PgPayrollError> {
    with_audits(pool, org, move |tx| {
        Box::pin(async move {
            let id = insert_contract_wage_in_tx(tx, &wage).await?;
            Ok((id, Vec::new()))
        })
    })
    .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_wage_refuses_without_appending_and_active_wage_succeeds(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "former-wage").await;
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,employment_status) VALUES ($1,'합성회사','합성직원','console','console',1,$2,'ACTIVE') RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(&pool).await.unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let mut wage = NewContractWage {
        org_id: *org.as_uuid(),
        employee_id: employee,
        created_by: *actor.as_uuid(),
        effective_from: date!(2026 - 10 - 01),
        wage_kind: "MONTHLY".into(),
        amount_won: 3_000_000,
        monthly_standard_hours: 200,
        source_note: "합성 근로계약".into(),
    };
    let recorded = record(&runtime, org, wage.clone()).await.unwrap();
    sqlx::query("UPDATE employees SET employment_status='EXITED',exit_date='2026-10-10' WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid()).bind(employee).execute(&pool).await.unwrap();
    wage.effective_from = date!(2026 - 11 - 01);
    let refused = KernelError::from(record(&runtime, org, wage).await.unwrap_err());
    assert_eq!(
        (refused.status_code(), refused.code),
        (409, Some("employee_exited_read_only"))
    );
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM employee_contract_wages WHERE org_id=$1 AND employee_id=$2",
    )
    .bind(org.as_uuid())
    .bind(employee)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [recorded],
        "refusal must leave the recorded wage unchanged"
    );
}
