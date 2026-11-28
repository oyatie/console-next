// SPDX-License-Identifier: LicenseRef-Proprietary
use super::pay_group::{JUNE, member, single_group_run};
use super::places::{pay_group, user};
use console_payroll_adapter_postgres::lifecycle::calculate_run_in_tx;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn clock_events_follow_the_pay_group_on_the_work_date(pool: PgPool) {
    use console_kernel_core::OrgId;
    use console_platform_db::{
        DbError, PERIOD_LOCKED, assert_employee_payroll_period_open, with_org_conn,
    };
    use console_platform_test_support::runtime_role_pool;
    let (f, le, site) = single_group_run(&pool, "REGULAR").await;
    let employee = member(&pool, &f, "clocked", (le, site)).await;
    let group: Uuid = sqlx::query_scalar("SELECT pay_group_id FROM payroll_draft_runs WHERE id=$1")
        .bind(f.run)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO period_locks (org_id,domain,pay_group_id,period_start,period_end,reason)
                 VALUES ($1,'payroll',$2,$3,$4,'Payroll freeze')",
    )
    .bind(f.org)
    .bind(group)
    .bind(JUNE.0)
    .bind(JUNE.1)
    .execute(&pool)
    .await
    .unwrap();
    let rt = runtime_role_pool(&pool).await;
    let check = |day| {
        with_org_conn::<_, _, DbError>(&rt, OrgId::from_uuid(f.org), move |tx| {
            Box::pin(async move {
                Ok(assert_employee_payroll_period_open(tx, f.org, employee, day).await)
            })
        })
    };
    assert_eq!(
        check(JUNE.0).await.unwrap().unwrap_err().code,
        Some(PERIOD_LOCKED)
    );
    let next = pay_group(&pool, f.org, le, super::pay_group::MONTHLY).await;
    sqlx::query("INSERT INTO employee_pay_group_assignments(org_id,employee_id,pay_group_id,effective_from,effective_to_exclusive)
                 VALUES ($1,$2,$3,'2026-06-01','2026-06-15'),($1,$2,$4,'2026-06-15',NULL)")
        .bind(f.org).bind(employee).bind(group).bind(next).execute(&pool).await.unwrap();
    assert_eq!(
        check(JUNE.0).await.unwrap().unwrap_err().code,
        Some(PERIOD_LOCKED)
    );
    check(JUNE.1).await.unwrap().unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn held_exceptions_follow_the_group_series_once_on_recalculation(pool: PgPool) {
    let (f, le, _) = single_group_run(&pool, "REGULAR").await;
    let group: Uuid = sqlx::query_scalar("SELECT pay_group_id FROM payroll_draft_runs WHERE id=$1")
        .bind(f.run)
        .fetch_one(&pool)
        .await
        .unwrap();
    let other = pay_group(&pool, f.org, le, super::pay_group::MONTHLY).await;
    let actor = user(&pool, f.org).await;
    let mut origin = None;
    for (pay_group, kind) in [(group, "REGULAR"), (group, "OFF_CYCLE"), (other, "REGULAR")] {
        let prior: Uuid = sqlx::query_scalar("INSERT INTO payroll_draft_runs(org_id,pay_group_id,kind,attribution_month,pay_date,
            period_start,period_end,variable_period_start,variable_period_end,source_label)
            VALUES($1,$2,$3,'2026-05-01','2026-05-31','2026-05-01','2026-05-31','2026-05-01','2026-05-31',gen_random_uuid()::text) RETURNING id")
            .bind(f.org).bind(pay_group).bind(kind).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO payroll_run_exceptions(org_id,run_id,employee_display_name,kind,severity,summary_ko,status,
             resolved_by,resolved_at,resolved_reason) SELECT $1,$2,'Member','RETRO_ADJUSTMENT','warn','amount pending','HELD',$3,now(),'next payroll' FROM generate_series(1,2)")
            .bind(f.org).bind(prior).bind(actor).execute(&pool).await.unwrap();
        if pay_group == group && kind == "REGULAR" {
            origin = Some(prior);
        }
    }
    sqlx::query("UPDATE payroll_draft_runs SET status='ATTENDANCE_CLOSED' WHERE id=$1")
        .bind(f.run)
        .execute(&pool)
        .await
        .unwrap();
    for expected in [2, 0] {
        let mut tx = pool.begin().await.unwrap();
        let result = calculate_run_in_tx(&mut tx, f.run).await.unwrap();
        assert_eq!(result.exceptions_created, expected);
        tx.commit().await.unwrap();
    }
    let carried: Vec<(Uuid,Uuid)> = sqlx::query_as("SELECT carried_from_run_id,(detail->>'carried_from_exception_id')::uuid FROM payroll_run_exceptions WHERE run_id=$1 AND status='OPEN'")
        .bind(f.run).fetch_all(&pool).await.unwrap();
    assert_eq!(carried.len(), 2);
    assert!(carried.iter().all(|(parent, _)| Some(*parent) == origin));
    assert_ne!(carried[0].1, carried[1].1);
}
