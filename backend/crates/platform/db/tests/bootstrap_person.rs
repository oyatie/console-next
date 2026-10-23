// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = false)]
async fn existing_bootstrap_admin_is_bound_and_runtime_backfill_preserves_it(pool: PgPool) {
    let migrator = sqlx::migrate!("./migrations");
    migrator.run_to(20261023070000000, &pool).await.unwrap();
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Bootstrap upgrade')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let user: Uuid = sqlx::query_scalar("INSERT INTO users(org_id,display_name,roles,is_tenant_ops) VALUES($1,'Bootstrap',ARRAY['SUPER_ADMIN'],true) RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert!(
        sqlx::query_scalar::<_, Option<Uuid>>("SELECT person_id FROM users WHERE id=$1")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap()
            .is_none()
    );
    migrator.run(&pool).await.unwrap();
    let person: Uuid = sqlx::query_scalar("SELECT p.id FROM users u JOIN persons p ON p.org_id=u.org_id AND p.id=u.person_id WHERE u.id=$1 AND u.is_tenant_ops")
        .bind(user).fetch_one(&pool).await.unwrap();
    let origin: (String,Option<Uuid>) = sqlx::query_as("SELECT origin,actor_id FROM person_revisions WHERE org_id=$1 AND person_id=$2 ORDER BY version DESC LIMIT 1")
        .bind(org).bind(person).fetch_one(&pool).await.unwrap();
    assert_eq!(origin, ("binding".to_owned(), None));
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT public.console_backfill_person_bindings($1)")
        .bind(org)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, Uuid>("SELECT person_id FROM users WHERE id=$1")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap(),
        person
    );
    let (alias,canonical):(Uuid,Uuid)=sqlx::query_as("INSERT INTO users(org_id,display_name) VALUES($1,'Linked administrator') RETURNING id,person_id")
        .bind(org).fetch_one(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT public.console_independent_people($1,$2,$3)")
            .bind(org)
            .bind(user)
            .bind(alias)
            .fetch_one(tx.as_mut())
            .await
            .unwrap()
    );
    sqlx::query("UPDATE users SET person_id=$2 WHERE id=$1")
        .bind(user)
        .bind(canonical)
        .execute(tx.as_mut())
        .await
        .unwrap();
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT public.console_independent_people($1,$2,$3)")
            .bind(org)
            .bind(user)
            .bind(alias)
            .fetch_one(tx.as_mut())
            .await
            .unwrap(),
        "an explicitly corrected bootstrap binding must agree with the same-person rule"
    );
    tx.commit().await.unwrap();
}
