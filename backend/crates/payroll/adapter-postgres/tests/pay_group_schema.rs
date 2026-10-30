// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::OrgId;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

async fn arm(pool: &PgPool, org: OrgId) -> Transaction<'_, Postgres> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx
}

async fn entity(pool: &PgPool, org: OrgId) -> Uuid {
    // rls-arming: ok owner seeds the legal-entity prerequisite before runtime writes.
    sqlx::query_scalar("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION') RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4()).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_group_rules_have_no_defaults_and_reject_missing_or_blank_values(pool: PgPool) {
    let columns: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT column_name,is_nullable,column_default FROM information_schema.columns
         WHERE table_name='pay_groups' AND column_name IN
         ('name','pay_date_rule','base_period','variable_period','proration','channel') ORDER BY column_name",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(
        columns.len(),
        6,
        "all consequential pay-group facts must exist"
    );
    assert!(
        columns
            .iter()
            .all(|(_, nullable, default)| nullable == "NO" && default.is_none())
    );
    let org = OrgId::from_uuid(Uuid::new_v4());
    seed_org_and_super_admin(&pool, *org.as_uuid(), "pay-group-schema").await;
    let entity = entity(&pool, org).await;
    let rt = runtime_role_pool(&pool).await;
    for column in [
        "name",
        "pay_date_rule",
        "base_period",
        "variable_period",
        "proration",
        "channel",
    ] {
        for value in [None, Some(" ")] {
            let mut tx = arm(&rt, org).await;
            let mut values = json!({"org_id":org.as_uuid(), "id":Uuid::new_v4(), "legal_entity_id":entity,
                "name":"모의 그룹", "pay_date_rule":{"day":"LAST_DAY","month_offset":0,"non_business_day":"PREVIOUS"},
                "base_period":{"start_day":"FIRST","month_offset":0}, "variable_period":{"start_day":16,"month_offset":-1},
                "proration":"CALENDAR_DAYS", "channel":"ATTESTATION_ONLY"});
            values[column] = json!(value);
            let query = sqlx::query(
                "INSERT INTO pay_groups SELECT (jsonb_populate_record(NULL::pay_groups,$1)).*",
            )
            .bind(values);
            let error = query.execute(tx.as_mut()).await.unwrap_err();
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some(if value.is_none() { "23502" } else { "23514" })
            );
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pay_groups_enforce_tenant_rls_and_composite_entity_foreign_key(pool: PgPool) {
    let a = OrgId::from_uuid(Uuid::new_v4());
    let b = OrgId::from_uuid(Uuid::new_v4());
    for org in [a, b] {
        seed_org_and_super_admin(&pool, *org.as_uuid(), "pay-group-isolation").await;
    }
    let entity = entity(&pool, a).await;
    let rt = runtime_role_pool(&pool).await;
    let insert = "INSERT INTO pay_groups(org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel) VALUES ($1,$2,$3,'explicit','{\"day\":\"LAST_DAY\",\"month_offset\":0,\"non_business_day\":\"PREVIOUS\"}','{\"start_day\":\"FIRST\",\"month_offset\":0}','{\"start_day\":16,\"month_offset\":-1}','CALENDAR_DAYS','ATTESTATION_ONLY')";
    let mut tx = arm(&rt, a).await;
    sqlx::query(insert)
        .bind(a.as_uuid())
        .bind(Uuid::new_v4())
        .bind(entity)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = arm(&rt, b).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM pay_groups")
            .fetch_one(tx.as_mut())
            .await
            .unwrap(),
        0
    );
    let error = sqlx::query(insert)
        .bind(a.as_uuid())
        .bind(Uuid::new_v4())
        .bind(entity)
        .execute(tx.as_mut())
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    let mut tx = arm(&rt, b).await;
    let error = sqlx::query(insert)
        .bind(b.as_uuid())
        .bind(Uuid::new_v4())
        .bind(entity)
        .execute(tx.as_mut())
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
}
