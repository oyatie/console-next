// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use sqlx::{PgPool, migrate::Migrator};
use std::borrow::Cow;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrations = false)]
async fn upgrading_preserves_enrollments_and_accepts_independent_registrations(pool: PgPool) {
    let change = MIGRATOR
        .iter()
        .find(|m| m.description == "release module registry")
        .unwrap();
    let mut migrations = Migrator {
        migrations: Cow::Owned(
            MIGRATOR
                .iter()
                .filter(|m| m.version < change.version)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    migrations.run(&pool).await.unwrap();
    let org: uuid::Uuid = sqlx::query_scalar("INSERT INTO organizations(id,slug,name) VALUES(gen_random_uuid(),'registry-test','Registry test') RETURNING id")
        .fetch_one(&pool).await.unwrap();
    let enroll = "INSERT INTO tenant_module_enrollments(org_id,module_key,enabled,change_ref) VALUES ($1,$2,true,'test-rollout') RETURNING revision";
    let initial: i64 = sqlx::query_scalar(enroll)
        .bind(org)
        .bind("calendar")
        .fetch_one(&pool)
        .await
        .unwrap();

    migrations.migrations.to_mut().push(change.clone());
    migrations.run(&pool).await.unwrap();
    let kept: (String, bool) = sqlx::query_as(
        "SELECT module_key,enabled FROM tenant_module_enrollments WHERE revision=$1",
    )
    .bind(initial)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(kept, (String::from("calendar"), true));

    let register = "INSERT INTO release_modules(module_key) VALUES($1)";
    let unknown = sqlx::query(register)
        .bind("unregistered")
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        unknown.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    for module in ["first_test", "second_test"] {
        sqlx::query("INSERT INTO setting_definitions(key,kind,default_ordinal,looser_when,governance) VALUES($1,'bool',1,'neutral','tenant')")
            .bind(format!("module.{module}.enabled")).execute(&pool).await.unwrap();
        sqlx::query(register)
            .bind(module)
            .execute(&pool)
            .await
            .unwrap();
        let _: i64 = sqlx::query_scalar(enroll)
            .bind(org)
            .bind(module)
            .fetch_one(&pool)
            .await
            .unwrap();
    }
    let unknown = sqlx::query(enroll)
        .bind(org)
        .bind("unregistered")
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        unknown.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_module_enrollments WHERE org_id=$1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 3);
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(&mut *tx)
        .await
        .unwrap();
    let denied = sqlx::query(register)
        .bind("runtime_test")
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert_eq!(
        denied.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
}
