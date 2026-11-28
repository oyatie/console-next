// SPDX-License-Identifier: LicenseRef-Proprietary
use super::pay_group::{JUNE, MONTHLY, member};
use super::places::*;
use super::seed::*;
use sqlx::PgPool;
use uuid::Uuid;

async fn group_with_member(pool: &PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
    let f = seed_org_and_run(pool).await;
    let entity = entity(pool, f.org).await;
    let site = workplace(pool, f.org, entity).await;
    let person = member(pool, &f, "transferred", (entity, site)).await;
    let first = pay_group(pool, f.org, entity, MONTHLY).await;
    sqlx::query("INSERT INTO employee_pay_group_assignments(org_id,employee_id,pay_group_id,effective_from,effective_to_exclusive) VALUES ($1,$2,$3,DATE '2026-05-01',DATE '2026-06-16')")
        .bind(f.org).bind(person).bind(first).execute(pool).await.unwrap();
    (f.org, entity, person, first)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn transfer_keeps_full_period_sources_in_one_regular_run(pool: PgPool) {
    let (org, entity, person, first) = group_with_member(&pool).await;
    let second = pay_group(&pool, org, entity, MONTHLY).await;
    sqlx::query("INSERT INTO employee_pay_group_assignments(org_id,employee_id,pay_group_id,effective_from) VALUES ($1,$2,$3,DATE '2026-06-16')")
        .bind(org).bind(person).bind(second).execute(&pool).await.unwrap();
    seed_import(
        &pool,
        org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "transferred",
        attendance_row(),
    )
    .await;
    let a = group_run(&pool, org, first, "REGULAR", JUNE).await;
    let b = group_run(&pool, org, second, "REGULAR", JUNE).await;
    for run in [&b, &a, &b] {
        materialise_for(&pool, run, JUNE).await;
    }
    assert_eq!(
        roster(&pool, &a).await,
        vec![("transferred".to_owned(), 0, 1)]
    );
    assert!(roster(&pool, &b).await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn erasure_can_remove_memberships_ordinary_deletion_preserves(pool: PgPool) {
    let (org, _, _, group) = group_with_member(&pool).await;
    let run = group_run(&pool, org, group, "REGULAR", JUNE).await;
    materialise_for(&pool, &run, JUNE).await;
    let lock: Uuid = sqlx::query_scalar("INSERT INTO period_locks (org_id,domain,pay_group_id,period_start,period_end,reason) VALUES ($1,'payroll',$2,$3,$4,'Payroll freeze') RETURNING id")
        .bind(org).bind(group).bind(JUNE.0).bind(JUNE.1).fetch_one(&pool).await.unwrap();
    let actor = user(&pool, org).await;
    let closed: Uuid = sqlx::query_scalar("INSERT INTO attendance_month_closes(org_id, month, checks, attested_by, period_lock_id) VALUES ($1,$2,'{}',$3,$4) RETURNING id")
        .bind(org).bind(JUNE.0).bind(actor).bind(lock).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO attendance_close_amendments(org_id,close_id,reason,detail,idempotency_key,request_fingerprint,actor_user_id) VALUES ($1,$2,'Amendment','Evidence','fixture-close-0001',repeat('a',64),$3)")
        .bind(org).bind(closed).bind(actor).execute(&pool).await.unwrap();
    let other = group_with_member(&pool).await.0;
    let denied = sqlx::query("DELETE FROM employee_pay_group_assignments WHERE org_id=$1")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        denied
            .as_database_error()
            .and_then(|db| db.code())
            .as_deref(),
        Some("25006")
    );
    sqlx::query("UPDATE organizations SET status='ARCHIVED' WHERE id=$1")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    let platform: Uuid = sqlx::query_scalar("SELECT id FROM organizations WHERE slug='platform'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let approver = user(&pool, platform).await;
    console_platform_test_support::governed_erase::due(&pool, org, approver).await;
    let mut command = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_platform_force_cmd")
        .execute(command.as_mut())
        .await
        .unwrap();
    let erased: i64 = sqlx::query_scalar("SELECT platform_run_due_tenant_erases()")
        .fetch_one(command.as_mut())
        .await
        .unwrap();
    assert_eq!(erased, 1);
    command.commit().await.unwrap();
    let survivors: Vec<Uuid> = sqlx::query_scalar(
        "SELECT org_id FROM employee_pay_group_assignments WHERE org_id=ANY($1)",
    )
    .bind([org, other].as_slice())
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(survivors, [other]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_new_group_does_not_pay_an_employee_already_on_a_closed_roster(pool: PgPool) {
    let (original, entity, site) = super::pay_group::single_group_run(&pool, "REGULAR").await;
    let person = member(&pool, &original, "frozen", (entity, site)).await;
    seed_import(
        &pool,
        original.org,
        "APPLIED",
        "CANDIDATE",
        JUNE,
        "frozen",
        attendance_row(),
    )
    .await;
    lock_period(&pool, original.org, JUNE).await;
    close(&pool, &original).await.unwrap();
    let second = pay_group(&pool, original.org, entity, MONTHLY).await;
    sqlx::query("INSERT INTO employee_pay_group_assignments(org_id,employee_id,pay_group_id,effective_from) VALUES ($1,$2,$3,$4)")
        .bind(original.org).bind(person).bind(second).bind(JUNE.0).execute(&pool).await.unwrap();
    let later = group_run(&pool, original.org, second, "REGULAR", JUNE).await;
    assert_eq!(materialise_for(&pool, &later, JUNE).await, 0);
    assert_eq!(
        roster(&pool, &original).await,
        vec![("frozen".to_owned(), 0, 1)]
    );
    assert!(roster(&pool, &later).await.is_empty());
}
