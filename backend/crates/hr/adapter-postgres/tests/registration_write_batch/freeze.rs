// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_batch_checks_each_hire_date_before_canonical_writes(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut requests = requests(&f, &pool).await;
    let frozen = today_kst() - time::Duration::days(40);
    requests[1].hire_date = Some(frozen.to_string());
    let hashes = hashes(&requests);
    let mut commands = inputs(&requests, &hashes);
    // Check the frozen hire after the open hire in the canonical writer's row order.
    let mut ids = [commands[0].employee_id, commands[1].employee_id];
    ids.sort();
    commands[0].employee_id = ids[0];
    commands[1].employee_id = ids[1];
    let before = counts(&pool, &f).await;
    sqlx::query(
        "INSERT INTO period_locks (org_id,domain,period_start,period_end,reason) \
        VALUES ($1,'payroll',$2,$2,'Synthetic closed period')",
    )
    .bind(f.principal.org_id.as_uuid())
    .bind(frozen)
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = transaction(&f).await;
    let error = create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &commands,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "period_locked");
    tx.rollback().await.unwrap();
    assert_eq!(counts(&pool, &f).await, before);
}
