use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn distinct_accounts_without_employee_or_person_bindings_refuse(pool: PgPool) {
    let p = parties(&pool).await;
    for account in [p.maker, p.independent] {
        sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
            .bind(account)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = decision_tx(&pool, &p, false).await;
        assert!(!independent(&mut tx, &p).await);
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn absent_binding_refuses_and_is_locked_against_concurrent_insertion(pool: PgPool) {
    let p = parties(&pool).await;
    let employee: Uuid = sqlx::query_scalar("SELECT employee_id FROM users WHERE id=$1")
        .bind(p.independent)
        .fetch_one(&pool)
        .await
        .unwrap();
    let person: Uuid =
        sqlx::query_scalar("SELECT person_id FROM employee_person_bindings WHERE employee_id=$1")
            .bind(p.employee)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=$1")
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = decision_tx(&pool, &p, false).await;
    assert!(!independent(&mut tx, &p).await);
    let mut writer = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout='250ms'")
        .execute(writer.as_mut())
        .await
        .unwrap();
    let error = sqlx::query("INSERT INTO employee_person_bindings (org_id,employee_id,person_id,actor_id,payload_digest) VALUES ($1,$2,$3,$4,$5)")
        .bind(p.org).bind(employee).bind(person).bind(p.independent).bind([7u8;32].as_slice()).execute(writer.as_mut()).await.expect_err("a decision must retain an absent binding fact too");
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("55P03")
    );
    writer.rollback().await.unwrap();
    tx.commit().await.unwrap();
    sqlx::query("INSERT INTO employee_person_bindings (org_id,employee_id,person_id,actor_id,payload_digest) VALUES ($1,$2,$3,$4,$5)")
        .bind(p.org).bind(employee).bind(person).bind(p.independent).bind([7u8;32].as_slice()).execute(&pool).await.unwrap();
    let mut retry = decision_tx(&pool, &p, false).await;
    assert!(!independent(&mut retry, &p).await);
    retry.rollback().await.unwrap();
}
