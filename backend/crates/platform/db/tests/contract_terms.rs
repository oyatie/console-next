// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use sqlx::PgPool;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn person(pool: &PgPool) -> (Uuid, Uuid, Uuid) {
    let (org, actor) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'계약 검증')")
        .bind(org)
        .bind(format!("terms-{}", org.simple()))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users(id,org_id,display_name,roles) VALUES($1,$2,'인사',$3)")
        .bind(actor)
        .bind(org)
        .bind(["SUPER_ADMIN"])
        .execute(pool)
        .await
        .unwrap();
    let employee = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,'회사','직원','console','console',1,$2) RETURNING id")
        .bind(org).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap();
    (org, employee, actor)
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn terms_refuse_invalid_schedule_and_effective_dates(pool: PgPool) {
    let p = person(&pool).await;
    for (extra, constraint) in [
        ("daily_minutes=0", "employee_contracts_daily_minutes_check"),
        (
            "daily_minutes=1441",
            "employee_contracts_daily_minutes_check",
        ),
        (
            "scheduled_days_per_week=0",
            "employee_contracts_scheduled_days_per_week_check",
        ),
        (
            "scheduled_days_per_week=8",
            "employee_contracts_scheduled_days_per_week_check",
        ),
        (
            "weekly_paid_minutes=-1",
            "employee_contracts_weekly_paid_minutes_check",
        ),
        (
            "weekly_paid_minutes=10081",
            "employee_contracts_weekly_paid_minutes_check",
        ),
        (
            "terms_effective_from='2025-12-31'",
            "employee_contracts_check",
        ),
        (
            "terms_effective_from='2027-01-01'",
            "employee_contracts_check",
        ),
    ] {
        // Probe INSERT because history cannot be edited, even to repair a schedule.
        let (column, value) = extra.split_once('=').unwrap();
        let query = format!(
            "INSERT INTO employee_contracts(org_id,employee_id,created_by,command_id,kind,start_date,end_date,wage_won,pay_unit,{column}) VALUES($1,$2,$3,gen_random_uuid(),'FIXED_TERM','2026-01-01','2026-12-31',3000000,'MONTHLY',{value})"
        );
        let error = sqlx::query(sqlx::AssertSqlSafe(query))
            .bind(p.0)
            .bind(p.1)
            .bind(p.2)
            .execute(&pool)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().constraint(),
            Some(constraint),
            "{extra}"
        );
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn terms_keep_legacy_inserts_and_append_only_history(pool: PgPool) {
    let function_absent: bool = sqlx::query_scalar(
        "SELECT to_regprocedure('employee_contract_terms_on(uuid,uuid,date)') IS NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(function_absent, "contract rules belong in the HR domain");
    let p = person(&pool).await;
    let legacy: Uuid = sqlx::query_scalar("INSERT INTO employee_contracts(org_id,employee_id,created_by,command_id,kind,start_date,wage_won,pay_unit,weekly_minutes) VALUES($1,$2,$3,gen_random_uuid(),'OPEN_ENDED','2026-01-01',3000000,'MONTHLY',2400) RETURNING id")
        .bind(p.0).bind(p.1).bind(p.2).fetch_one(&pool).await.unwrap();
    let absent: (Option<i32>, Option<i32>, Option<i32>, Option<time::Date>) = sqlx::query_as(
        "SELECT daily_minutes,scheduled_days_per_week,weekly_paid_minutes,terms_effective_from FROM employee_contracts WHERE id=$1",
    ).bind(legacy).fetch_one(&pool).await.unwrap();
    assert_eq!(absent, (None, None, None, None));
    for query in [
        "UPDATE employee_contracts SET daily_minutes=480 WHERE id=$1",
        "DELETE FROM employee_contracts WHERE id=$1",
    ] {
        let error = sqlx::query(query)
            .bind(legacy)
            .execute(&pool)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("55000")
        );
    }
}
