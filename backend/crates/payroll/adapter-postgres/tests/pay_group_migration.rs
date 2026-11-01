// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::OrgId;
use console_platform_test_support::{MIGRATOR, runtime_role_pool, seed_org_and_super_admin};
use sqlx::{PgPool, migrate::Migrator};
use std::borrow::Cow;
use uuid::Uuid;

async fn old_writer(pool: &PgPool, org: OrgId, entity: Uuid) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await?;
    sqlx::query("INSERT INTO pay_groups(org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel) VALUES ($1,$2,$3,'기존 급여','{\"day\":\"LAST_DAY\",\"month_offset\":0,\"non_business_day\":\"PREVIOUS\"}','{\"start_day\":\"FIRST\",\"month_offset\":0}','{\"start_day\":16,\"month_offset\":-1}','CALENDAR_DAYS','ATTESTATION_ONLY')")
        .bind(org.as_uuid()).bind(Uuid::new_v4()).bind(entity).execute(tx.as_mut()).await?;
    tx.commit().await
}

#[sqlx::test(migrations = false)]
async fn populated_pay_groups_expand_without_defaults_and_keep_old_writer_working(pool: PgPool) {
    let before = Migrator {
        migrations: Cow::Owned(
            MIGRATOR
                .iter()
                .filter(|m| m.version < 20261030100000000)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    before.run(&pool).await.unwrap();
    let org = OrgId::from_uuid(Uuid::new_v4());
    seed_org_and_super_admin(&pool, *org.as_uuid(), "pay-group-expand").await;
    // rls-arming: ok owner seeds the legal entity before runtime writes.
    let entity: Uuid = sqlx::query_scalar("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION') RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4()).fetch_one(&pool).await.unwrap();
    let rt = runtime_role_pool(&pool).await;
    old_writer(&rt, org, entity).await.unwrap();
    MIGRATOR.run(&pool).await.unwrap();
    old_writer(&rt, org, entity).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pay_groups WHERE org_id=$1 AND sensitive IS NULL AND pay_basis_allowed IS NULL")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 2, "existing and N-1 rows keep their unknown choices");

    let contract =
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../platform/db/pending/20261030100000000_pay_group_explicit_basis.contract.sql",
        ))
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    let error = sqlx::raw_sql(sqlx::AssertSqlSafe(contract.as_str()))
        .execute(tx.as_mut())
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23502")
    );
    tx.rollback().await.unwrap();

    // rls-arming: ok owner fixture simulates explicit completion before the later contract.
    sqlx::query(
        "UPDATE pay_groups SET sensitive=true,pay_basis_allowed=ARRAY['HOURLY'] WHERE org_id=$1",
    )
    .bind(org.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(contract.as_str()))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let error = old_writer(&rt, org, entity).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23502")
    );
    let required: i64 = sqlx::query_scalar("SELECT count(*) FROM information_schema.columns WHERE table_name='pay_groups' AND column_name IN ('sensitive','pay_basis_allowed') AND is_nullable='NO'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(required, 2);
}
