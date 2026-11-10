// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

async fn database_clock(pool: &PgPool, offset: &str) {
    // New runtime connections share a shifted DB clock; the app clock stays untouched.
    let mut conn = pool.acquire().await.unwrap();
    sqlx::query("SELECT set_config('test.intake_clock_offset',$1,false)")
        .bind(offset)
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE SCHEMA intake_clock;
         CREATE FUNCTION intake_clock.clock_timestamp() RETURNS timestamptz
         LANGUAGE sql VOLATILE AS $$
           SELECT pg_catalog.clock_timestamp() + current_setting('test.intake_clock_offset')::interval
         $$;
         GRANT USAGE ON SCHEMA intake_clock TO console_rt;
         DO $$ BEGIN
           EXECUTE format('ALTER DATABASE %I SET search_path=intake_clock,pg_catalog,public',current_database());
           EXECUTE format('ALTER DATABASE %I SET test.intake_clock_offset=%L',current_database(),current_setting('test.intake_clock_offset'));
         END $$;",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_intake_reaches_live_handlers_with_clock_paging_and_tenant_isolation(pool: PgPool) {
    database_clock(&pool, "5 minutes").await;
    assert_intake(pool).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_intake_remains_visible_when_the_app_clock_is_ahead(pool: PgPool) {
    database_clock(&pool, "-5 minutes").await;
    assert_intake(pool).await;
}
