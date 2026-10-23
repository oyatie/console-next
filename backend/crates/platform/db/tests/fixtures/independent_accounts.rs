use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn canonical_people_remain_bound_without_employee_links(pool: PgPool) {
    let p = parties(&pool).await;
    for account in [p.maker, p.independent] {
        sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
            .bind(account)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = decision_tx(&pool, &p, false).await;
        assert!(independent(&mut tx, &p).await);
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn an_unbound_party_never_substitutes_an_account_identity(pool: PgPool) {
    let p = parties(&pool).await;
    for user in [p.maker, p.independent] {
        let mut identity = pool.begin().await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops=false,person_id=public.console_employee_person(org_id,employee_id) WHERE id=ANY($1)")
            .bind(vec![p.maker,p.independent]).execute(identity.as_mut()).await.unwrap();
        sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
            .bind(user)
            .execute(identity.as_mut())
            .await
            .unwrap();
        identity.commit().await.unwrap();
        let mut tx = decision_tx(&pool, &p, false).await;
        assert!(!independent(&mut tx, &p).await);
        tx.rollback().await.unwrap();
    }
}
