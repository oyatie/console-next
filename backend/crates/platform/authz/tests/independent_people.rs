// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

use console_kernel_core::UserId;
use console_platform_authz::cedar_pbac::actions::independent_people::authorized_in_tx;
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_requires_canonical_people_even_if_the_sql_invariant_is_removed(pool: PgPool) {
    let org = Uuid::new_v4();
    let maker = seed_org_and_super_admin(&pool, org, "cedar-sod").await;
    let (_, person) = person_fixtures::bind_user_to_distinct_person(&pool, maker).await;
    let same = seed_active_user(&pool, org, "ADMIN", "same").await;
    person_fixtures::bind_user_to_person(&pool, same, person).await;
    let checker = seed_active_user(&pool, org, "ADMIN", "checker").await;
    person_fixtures::bind_user_to_distinct_person(&pool, checker).await;
    let unlinked = seed_active_user(&pool, org, "ADMIN", "unlinked").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(unlinked.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET employee_id=NULL WHERE id=ANY($1)")
        .bind(vec![*maker.as_uuid(), *same.as_uuid(), *checker.as_uuid()])
        .execute(&pool)
        .await
        .unwrap();
    // Mutation control: Cedar must decide from identities, not trust this boolean.
    sqlx::query("CREATE OR REPLACE FUNCTION public.console_independent_people(p_org UUID,p_maker UUID,p_checker UUID) RETURNS BOOLEAN LANGUAGE sql AS 'SELECT true'")
        .execute(&pool).await.unwrap();
    let rt = runtime_role_pool(&pool).await;
    for (maker, checker, allowed) in [
        (Some(maker), checker, true),
        (Some(maker), maker, false),
        (Some(maker), same, false),
        (Some(maker), unlinked, false),
        (Some(unlinked), checker, false),
        (None, checker, false),
        (Some(maker), UserId::new(), false),
    ] {
        let mut tx = rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        assert_eq!(
            authorized_in_tx(&mut tx, maker.map(|u| *u.as_uuid()), *checker.as_uuid())
                .await
                .unwrap(),
            allowed
        );
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn resolver_errors_and_missing_tenant_context_refuse(pool: PgPool) {
    let mut tx = pool.begin().await.unwrap();
    assert!(
        !authorized_in_tx(&mut tx, Some(Uuid::new_v4()), Uuid::new_v4())
            .await
            .unwrap()
    );
    tx.rollback().await.unwrap();
    sqlx::query("CREATE OR REPLACE FUNCTION public.console_decision_people(p_org UUID,p_maker UUID,p_checker UUID) RETURNS TABLE (maker_person UUID, checker_person UUID) LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'resolver unavailable'; END $$")
        .execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(Uuid::new_v4().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    assert!(
        !authorized_in_tx(&mut tx, Some(Uuid::new_v4()), Uuid::new_v4())
            .await
            .unwrap()
    );
    assert_eq!(
        sqlx::query("SELECT 1")
            .execute(tx.as_mut())
            .await
            .unwrap_err()
            .as_database_error()
            .unwrap()
            .code()
            .as_deref(),
        Some("25P02")
    );
    tx.rollback().await.unwrap();
}
