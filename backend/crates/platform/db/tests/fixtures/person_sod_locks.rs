use super::*;

pub(super) async fn independent(tx: &mut Transaction<'_, Postgres>, p: &Parties) -> bool {
    sqlx::query_scalar("SELECT public.console_independent_people($1,$2,$3)")
        .bind(p.org)
        .bind(p.maker)
        .bind(p.independent)
        .fetch_one(tx.as_mut())
        .await
        .unwrap()
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn person_facts_hold_canonical_account_locks_until_decision_commits(pool: PgPool) {
    let p = parties(&pool).await;
    let mut decision = decision_tx(&pool, &p, false).await;
    assert!(independent(&mut decision, &p).await);
    for sql in [
        "UPDATE users SET employee_id=$1 WHERE id=$2",
        "UPDATE users SET person_id=$1 WHERE id=$2",
    ] {
        let mut writer = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL lock_timeout='250ms'")
            .execute(writer.as_mut())
            .await
            .unwrap();
        let error = sqlx::query(sql)
            .bind(p.employee)
            .bind(p.maker)
            .execute(writer.as_mut())
            .await
            .expect_err("decision must retain the person fact");
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("55P03")
        );
        writer.rollback().await.unwrap();
    }
    decision.commit().await.unwrap();
    let mut writer = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout='250ms'")
        .execute(writer.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE users SET employee_id=employee_id WHERE id=$1")
        .bind(p.independent)
        .execute(writer.as_mut())
        .await
        .unwrap();
    sqlx::query("DELETE FROM employee_person_bindings WHERE actor_id=$1")
        .bind(p.independent)
        .execute(writer.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_person_bindings (org_id,employee_id,person_id,actor_id,payload_digest) SELECT $1,u.employee_id,b.person_id,$2,$3 FROM users u JOIN employee_person_bindings b ON b.employee_id=$4 AND b.org_id=u.org_id WHERE u.id=$2")
        .bind(p.org).bind(p.independent).bind([7u8;32].as_slice()).bind(p.employee)
        .execute(writer.as_mut()).await.unwrap();
    writer.commit().await.unwrap();
    let mut retry = decision_tx(&pool, &p, false).await;
    assert!(!independent(&mut retry, &p).await);
    retry.rollback().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn same_person_alias_missing_account_and_foreign_context_deny(pool: PgPool) {
    let p = parties(&pool).await;
    let mut tx = decision_tx(&pool, &p, false).await;
    for (org, maker, checker) in [
        (p.org, Some(p.maker), p.maker),
        (p.org, None, p.independent),
        (p.org, Some(p.same_person_alias), p.maker),
        (p.org, Some(p.maker), Uuid::new_v4()),
        (Uuid::new_v4(), Some(p.maker), p.independent),
    ] {
        let allowed: bool =
            sqlx::query_scalar("SELECT public.console_independent_people($1,$2,$3)")
                .bind(org)
                .bind(maker)
                .bind(checker)
                .fetch_one(tx.as_mut())
                .await
                .unwrap();
        assert!(!allowed);
    }
    tx.rollback().await.unwrap();
    sqlx::query("DELETE FROM employee_person_bindings WHERE org_id=$1 AND actor_id=$2")
        .bind(p.org)
        .bind(p.maker)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = decision_tx(&pool, &p, false).await;
    let allowed: bool = sqlx::query_scalar("SELECT public.console_independent_people($1,$2,$3)")
        .bind(p.org)
        .bind(p.maker)
        .bind(p.maker)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert!(!allowed);
    tx.rollback().await.unwrap();
}
