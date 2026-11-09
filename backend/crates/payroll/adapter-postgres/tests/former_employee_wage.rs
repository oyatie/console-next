// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Ordinary wage writes use the same employee-state boundary as personnel records.
use console_kernel_core::{KernelError, OrgId};
use console_payroll_adapter_postgres::{
    PgPayrollError,
    payslip_draft::{NewContractWage, insert_contract_wage_in_tx},
};
use console_platform_db::{DbError, with_audits};
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

async fn fixture(pool: &PgPool) -> (PgPool, OrgId, NewContractWage) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(pool, *org.as_uuid(), "former-wage").await;
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,employment_status) VALUES ($1,'합성회사','합성직원','console','console',1,$2,'ACTIVE') RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
    let runtime = runtime_role_pool(pool).await;
    let wage = NewContractWage {
        org_id: *org.as_uuid(),
        employee_id: employee,
        created_by: *actor.as_uuid(),
        effective_from: date!(2026 - 10 - 01),
        wage_kind: "MONTHLY".into(),
        amount_won: 3_000_000,
        monthly_standard_hours: 200,
        source_note: "합성 근로계약".into(),
    };
    (runtime, org, wage)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_wage_refuses_without_appending_and_active_wage_succeeds(pool: PgPool) {
    let (runtime, org, mut wage) = fixture(&pool).await;
    let employee = wage.employee_id;
    let recorded = record(&runtime, org, wage.clone()).await.unwrap();
    sqlx::query("UPDATE employees SET employment_status='EXITED',exit_date='2026-10-10' WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid()).bind(employee).execute(&pool).await.unwrap();
    for effective_from in [wage.effective_from, date!(2026 - 11 - 01)] {
        wage.effective_from = effective_from;
        let refused = KernelError::from(record(&runtime, org, wage.clone()).await.unwrap_err());
        assert_eq!(
            (refused.status_code(), refused.code),
            (409, Some("employee_exited_read_only"))
        );
    }
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

fn assert_duplicate(error: PgPayrollError) {
    let error = KernelError::from(error);
    assert_eq!(
        (error.status_code(), error.code),
        (409, Some("contract_wage_exists")),
        "{error:?}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn duplicate_wages_preserve_original_and_allow_other_dates_and_employees(pool: PgPool) {
    let (runtime, org, wage) = fixture(&pool).await;
    let id = record(&runtime, org, wage.clone()).await.unwrap();
    let original: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(w) FROM employee_contract_wages w WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    for changed in [false, true] {
        let mut duplicate = wage.clone();
        if changed {
            duplicate.wage_kind = "HOURLY".into();
            duplicate.amount_won = 20_000;
            duplicate.monthly_standard_hours = 209;
            duplicate.source_note = "변경한 합성 근로계약".into();
        }
        assert_duplicate(record(&runtime, org, duplicate).await.unwrap_err());
        let rows: Vec<serde_json::Value> =
            sqlx::query_scalar("SELECT to_jsonb(w) FROM employee_contract_wages w WHERE org_id=$1")
                .bind(org.as_uuid())
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(rows.as_slice(), std::slice::from_ref(&original));
    }
    let mut later = wage.clone();
    later.effective_from = date!(2026 - 11 - 01);
    later.source_note = "나중 근로계약".into();
    assert_ne!(record(&runtime, org, later).await.unwrap(), id);
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES ($1,'합성회사','다른직원','console','console',2,$2) RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(&pool).await.unwrap();
    let mut other = wage.clone();
    other.employee_id = employee;
    other.source_note = "다른 근로계약".into();
    assert_ne!(record(&runtime, org, other).await.unwrap(), id);

    // Other database constraints must retain their original error, including unique violations.
    sqlx::query(
        "CREATE UNIQUE INDEX test_wage_source_note_key ON employee_contract_wages(source_note)",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (amount, actor, expected_code, expected_constraint) in [
        (
            0,
            wage.created_by,
            "23514",
            "employee_contract_wages_amount_won_check",
        ),
        (
            wage.amount_won,
            Uuid::new_v4(),
            "23503",
            "employee_contract_wages_created_by_org_id_fkey",
        ),
        (
            wage.amount_won,
            wage.created_by,
            "23505",
            "test_wage_source_note_key",
        ),
    ] {
        let mut invalid = wage.clone();
        invalid.effective_from = date!(2026 - 12 - 01);
        invalid.amount_won = amount;
        invalid.created_by = actor;
        if expected_code != "23505" {
            invalid.source_note = "제약 검사".into();
        }
        let error = record(&runtime, org, invalid).await.unwrap_err();
        let PgPayrollError::Db(DbError::Sqlx(error)) = error else {
            panic!("unrelated constraint was mapped to a domain conflict: {error}");
        };
        let db = error.as_database_error().unwrap();
        assert_eq!(db.code().as_deref(), Some(expected_code));
        assert_eq!(db.constraint(), Some(expected_constraint));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_duplicate_wages_have_one_winner(pool: PgPool) {
    let (runtime, org, wage) = fixture(&pool).await;
    let (first, second) = tokio::join!(
        record(&runtime, org, wage.clone()),
        record(&runtime, org, wage),
    );
    let (id, error) = match (first, second) {
        (Ok(id), Err(error)) | (Err(error), Ok(id)) => (id, error),
        other => panic!("expected exactly one committed wage: {other:?}"),
    };
    assert_duplicate(error);
    let rows: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM employee_contract_wages WHERE org_id=$1")
            .bind(org.as_uuid())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows, [id]);
}
