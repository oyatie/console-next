#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::PgPool;

const EXPAND: &str =
    include_str!("../../../platform/db/migrations/20261020052000000_trade_name_nullable.sql");

#[sqlx::test(migrations = false)]
async fn name_expand_times_out_under_contention_and_can_be_retried(owner: PgPool) {
    sqlx::raw_sql(
        "CREATE TABLE business_registration_revisions (trade_name TEXT NOT NULL \
           CHECK (char_length(btrim(trade_name)) BETWEEN 1 AND 200)); \
         INSERT INTO business_registration_revisions VALUES ('주식회사 기존')",
    )
    .execute(&owner)
    .await
    .unwrap();
    let mut blocker = owner.begin().await.unwrap();
    sqlx::query("LOCK TABLE business_registration_revisions IN ACCESS SHARE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let mut upgrade = owner.begin().await.unwrap();
    // Disable inherited defaults so only the migration can bound its lock wait.
    sqlx::raw_sql("SET LOCAL lock_timeout = '0'; SET LOCAL statement_timeout = '5s'")
        .execute(&mut *upgrade)
        .await
        .unwrap();
    let error = sqlx::raw_sql(EXPAND)
        .execute(&mut *upgrade)
        .await
        .expect_err("a busy table must abort the expand step at its lock timeout");
    upgrade.rollback().await.unwrap();
    blocker.rollback().await.unwrap();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("55P03")
    );
    assert!(error.to_string().contains("lock timeout"), "{error}");
    let nullable: String = sqlx::query_scalar(
        "SELECT is_nullable FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = 'business_registration_revisions' AND column_name = 'trade_name'",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        nullable, "NO",
        "the failed expand step leaves the schema intact"
    );

    let mut upgrade = owner.begin().await.unwrap();
    sqlx::raw_sql(EXPAND).execute(&mut *upgrade).await.unwrap();
    upgrade.commit().await.unwrap();
    sqlx::query("INSERT INTO business_registration_revisions VALUES ('주식회사 N-1'), (NULL), (repeat('한', 200))")
        .execute(&owner)
        .await
        .unwrap();
    let counts: (i64, i64) =
        sqlx::query_as("SELECT count(*), count(trade_name) FROM business_registration_revisions")
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(counts, (4, 3));
    for invalid in ["", &"한".repeat(201)] {
        let error = sqlx::query("INSERT INTO business_registration_revisions VALUES ($1)")
            .bind(invalid)
            .execute(&owner)
            .await
            .expect_err("the existing name length constraint remains enforced");
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514")
        );
    }
}
