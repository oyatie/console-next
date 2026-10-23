// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::PgPool;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn runtime_backfill_includes_voided_rows_and_restores_visibility(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Voided binding')")
        .bind(org)
        .bind(org.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let actor: Uuid = sqlx::query_scalar(
        "INSERT INTO users(org_id,display_name) VALUES($1,'Actor') RETURNING id",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key,employment_status,voided_at,voided_by,void_reason_code,void_mode) VALUES($1,'Co','Former','test','test',1,'void','VOIDED',now(),$2,'DUPLICATE_ENTRY','SETUP') RETURNING id")
        .bind(org).bind(actor).fetch_one(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT console_backfill_person_bindings($1)")
        .bind(org)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let person: Option<Uuid> = sqlx::query_scalar("SELECT console_employee_person($1,$2)")
        .bind(org)
        .bind(employee)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert!(person.is_some());
    let hidden: bool = sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM employees WHERE id=$1)")
        .bind(employee)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert!(
        hidden,
        "the backfill must restore normal voided-row visibility"
    );
    let foreign: i64 =
        sqlx::query_scalar("SELECT count(*) FROM person_accounts_current WHERE org_id<>$1")
            .bind(org)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(foreign, 0);
    tx.commit().await.unwrap();
}
