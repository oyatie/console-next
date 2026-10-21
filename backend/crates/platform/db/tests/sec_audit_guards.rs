#![allow(clippy::unwrap_used, clippy::expect_used)]
//! INF-07: audit_events refuses TRUNCATE, console_app carries lock_timeout=2s,
//! and audit_access_projection carries no snapshot columns and is closed to
//! the runtime role.

use sqlx::{PgPool, Row};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn insert_platform_audit_row(pool: &PgPool) -> uuid::Uuid {
    sqlx::query_scalar(
        "INSERT INTO audit_events (action, target_type, target_id, before_snap, after_snap,
                                   trace_id, span_id, occurred_at, ip)
         VALUES ('platform.sec_probe', 'probe', 'p-1', '{\"x\":1}', '{\"x\":2}',
                 repeat('a', 32), repeat('b', 16), now(), '203.0.113.7')
         RETURNING id",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn truncate_audit_events_is_refused_for_owner_and_superuser(pool: PgPool) {
    insert_platform_audit_row(&pool).await;

    // A plain TRUNCATE already stops at the audit_chain_seals foreign key;
    // CASCADE goes through it, and is what the statement trigger closes.
    let superuser = sqlx::query("TRUNCATE audit_events CASCADE")
        .execute(&pool)
        .await
        .unwrap_err();
    assert!(
        superuser.to_string().contains("TRUNCATE is forbidden"),
        "{superuser}"
    );

    // In production console_app owns every table, so it holds TRUNCATE on
    // audit_events and on everything CASCADE reaches through foreign keys; the
    // test database's owner is the superuser, so hand console_app the same
    // privilege inside this (rolled-back) transaction. Without it the statement
    // stops at a permission check and never reaches the trigger under test.
    let mut owner = pool.begin().await.unwrap();
    sqlx::query("GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO console_app")
        .execute(&mut *owner)
        .await
        .unwrap();
    sqlx::query("SET LOCAL ROLE console_app")
        .execute(&mut *owner)
        .await
        .unwrap();
    let as_owner = sqlx::query("TRUNCATE audit_events CASCADE")
        .execute(&mut *owner)
        .await
        .unwrap_err();
    assert!(
        as_owner.to_string().contains("TRUNCATE is forbidden"),
        "{as_owner}"
    );
    drop(owner);

    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = 'platform.sec_probe'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rows, 1);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn console_app_role_default_lock_timeout_is_two_seconds(pool: PgPool) {
    let settings: Vec<String> = sqlx::query_scalar(
        "SELECT unnest(settings.setconfig)
         FROM pg_db_role_setting settings
         JOIN pg_roles role ON role.oid = settings.setrole
         WHERE role.rolname = 'console_app' AND settings.setdatabase = 0",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        settings.iter().any(|s| s == "lock_timeout=2s"),
        "{settings:?}"
    );
}

/// Production migrates AS console_app (not a superuser), so 0260 takes its
/// `ELSIF current_user = 'console_app'` branch: the role must be allowed to set
/// its own default. Rolled back with the transaction.
#[sqlx::test(migrator = "MIGRATOR")]
async fn console_app_may_set_its_own_lock_timeout_default(pool: PgPool) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    let is_superuser: String = sqlx::query_scalar("SELECT current_setting('is_superuser')")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(is_superuser, "off");
    sqlx::query("ALTER ROLE console_app SET lock_timeout = '2s'")
        .execute(&mut *tx)
        .await
        .unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn access_projection_has_no_snapshots_and_hashes_the_full_row(pool: PgPool) {
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name::text FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'audit_access_projection'
         ORDER BY ordinal_position",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        columns,
        [
            "id",
            "org_id",
            "actor",
            "occurred_at",
            "ip",
            "action",
            "target_type",
            "target_id",
            "row_sha256"
        ]
    );

    let id = insert_platform_audit_row(&pool).await;
    let row = sqlx::query(
        "SELECT p.row_sha256,
                encode(sha256(convert_to(to_jsonb(e)::text, 'UTF8')), 'hex') AS expected
         FROM audit_access_projection p JOIN audit_events e ON e.id = p.id
         WHERE p.id = $1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let hash: String = row.get("row_sha256");
    assert_eq!(hash.len(), 64);
    assert_eq!(hash, row.get::<String, _>("expected"));
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn access_projection_is_closed_to_the_runtime_role(pool: PgPool) {
    insert_platform_audit_row(&pool).await;
    let readable: bool = sqlx::query_scalar(
        "SELECT has_table_privilege('console_rt', 'audit_access_projection', 'SELECT')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !readable,
        "an owner-rights view would hand console_rt every tenant's rows"
    );

    let mut runtime = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(&mut *runtime)
        .await
        .unwrap();
    let denied = sqlx::query("SELECT count(*) FROM audit_access_projection")
        .fetch_one(&mut *runtime)
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("permission denied"), "{denied}");
}
