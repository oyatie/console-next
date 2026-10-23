// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use sqlx::PgPool;
use uuid::Uuid;
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn runtime_cannot_use_the_erasure_setting_to_unbind_a_tenant_account(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Projection guard')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let account: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,display_name) VALUES($1,'Retained') RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    for setting in ["app.pii_destruction", "app.platform_force_remove_org"] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true),set_config($2,'on',true)")
            .bind(org.to_string())
            .bind(setting)
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("SET LOCAL ROLE console_rt")
            .execute(tx.as_mut())
            .await
            .unwrap();
        let error =
            sqlx::query("UPDATE users SET principal_kind='VENDOR',person_id=NULL WHERE id=$1")
                .bind(account)
                .execute(tx.as_mut())
                .await
                .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514"),
            "{setting}"
        );
        tx.rollback().await.unwrap();
    }
}
