// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::OrgId;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::PgPool;
use uuid::Uuid;

async fn group(pool: &PgPool, org: OrgId) -> Uuid {
    seed_org_and_super_admin(pool, *org.as_uuid(), "run-preview-schema").await;
    // rls-arming: ok owner seeds prerequisites; constraints below run as console_rt.
    sqlx::query_scalar("WITH entity AS (INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION') RETURNING id) INSERT INTO pay_groups(org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel,sensitive,pay_basis_allowed) SELECT $1,$3,id,'모의 급여','{\"day\":\"LAST_DAY\",\"month_offset\":0,\"non_business_day\":\"PREVIOUS\"}','{\"start_day\":\"FIRST\",\"month_offset\":0}','{\"start_day\":16,\"month_offset\":-1}','CALENDAR_DAYS','ATTESTATION_ONLY',false,ARRAY['MONTHLY'] FROM entity RETURNING id")
        .bind(org.as_uuid()).bind(Uuid::new_v4()).bind(Uuid::new_v4()).fetch_one(pool).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regular_identity_is_unique_per_group_month_and_void_releases_it(pool: PgPool) {
    let org = OrgId::one();
    let group = group(&pool, org).await;
    let runtime = runtime_role_pool(&pool).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let insert = "INSERT INTO payroll_draft_runs(org_id,pay_group_id,kind,attribution_month,pay_date,period_start,period_end,variable_period_start,variable_period_end,source_label) VALUES ($1,$2,$3,'2026-11-01','2026-11-25','2026-11-01','2026-11-30','2026-10-16','2026-11-15',$4)";
    sqlx::query(insert)
        .bind(org.as_uuid())
        .bind(group)
        .bind("REGULAR")
        .bind("first")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SAVEPOINT duplicate")
        .execute(tx.as_mut())
        .await
        .unwrap();
    let error = sqlx::query(insert)
        .bind(org.as_uuid())
        .bind(group)
        .bind("REGULAR")
        .bind("duplicate")
        .execute(tx.as_mut())
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some("payroll_regular_run_month_key")
    );
    sqlx::query("ROLLBACK TO SAVEPOINT duplicate")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(insert)
        .bind(org.as_uuid())
        .bind(group)
        .bind("OFF_CYCLE")
        .bind("other-kind")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE payroll_draft_runs SET status='VOID' WHERE kind='REGULAR'")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(insert)
        .bind(org.as_uuid())
        .bind(group)
        .bind("REGULAR")
        .bind("replacement")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Legacy staging keeps its original natural key and needs no group defaults.
    sqlx::query("INSERT INTO payroll_draft_runs(org_id,period_start,period_end,source_label) VALUES ($1,'2026-11-01','2026-11-30','legacy') ON CONFLICT(org_id,period_start,period_end,source_label) DO UPDATE SET source_label=EXCLUDED.source_label")
        .bind(org.as_uuid()).execute(tx.as_mut()).await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn run_identity_refuses_foreign_groups_incomplete_facts_and_unknown_kinds(pool: PgPool) {
    let org = OrgId::one();
    let own = group(&pool, org).await;
    let foreign = group(&pool, OrgId::from_uuid(Uuid::new_v4())).await;
    let runtime = runtime_role_pool(&pool).await;
    for (group, kind, month, code) in [
        (Some(foreign), Some("REGULAR"), Some("2026-11-01"), "23503"),
        (Some(own), None, None, "23514"),
        (None, Some("REGULAR"), Some("2026-11-01"), "23514"),
        (Some(own), Some("REGULAR"), None, "23514"),
        (Some(own), Some("BONUS"), Some("2026-11-01"), "23514"),
        (Some(own), Some("REGULAR"), Some("2026-11-02"), "23514"),
    ] {
        let mut tx = runtime.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let error = sqlx::query("INSERT INTO payroll_draft_runs(org_id,pay_group_id,kind,attribution_month,pay_date,period_start,period_end,variable_period_start,variable_period_end,source_label) VALUES ($1,$2,$3,$4::text::date,'2026-11-25','2026-11-01','2026-11-30','2026-10-16','2026-11-15','invalid')")
            .bind(org.as_uuid()).bind(group).bind(kind).bind(month).execute(tx.as_mut()).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some(code)
        );
        tx.rollback().await.unwrap();
    }
}
