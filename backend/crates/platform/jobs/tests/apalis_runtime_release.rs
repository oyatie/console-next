//! The runtime pool closes a connection released inside a transaction sqlx
//! does not track (what a request dropped inside `begin` leaves), and keeps a
//! cleanly released one.
#![allow(clippy::expect_used)]

use std::time::Duration;

use console_platform_jobs::{connect_apalis_runtime_pool, migrate_and_reconcile_apalis_postgres};
use sqlx::Connection as _;

#[sqlx::test]
async fn runtime_pool_closes_a_connection_released_in_an_untracked_transaction() {
    let owner_url = std::env::var("CONSOLE_APALIS_OWNER_DATABASE_URL")
        .expect("CONSOLE_APALIS_OWNER_DATABASE_URL is required");
    let runtime_url = std::env::var("CONSOLE_APALIS_RUNTIME_DATABASE_URL")
        .expect("CONSOLE_APALIS_RUNTIME_DATABASE_URL is required");
    for url in [&owner_url, &runtime_url] {
        reassert_password(url).await;
    }
    let mut owner = sqlx::PgConnection::connect(&owner_url)
        .await
        .expect("connect as console_app");
    migrate_and_reconcile_apalis_postgres(&mut owner)
        .await
        .expect("migrate and reconcile Apalis as owner");
    let pool = connect_apalis_runtime_pool(&runtime_url)
        .await
        .expect("connect the runtime pool");

    let mut conn = pool.acquire().await.expect("borrow a runtime connection");
    let clean = backend_pid(&mut conn).await;
    drop(conn);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        alive(&mut owner, clean).await,
        "a clean release stays pooled"
    );

    let mut conn = pool.acquire().await.expect("borrow a runtime connection");
    let orphaned = backend_pid(&mut conn).await;
    apalis_sqlx::raw_sql("BEGIN")
        .execute(&mut *conn)
        .await
        .expect("untracked BEGIN runs");
    drop(conn);
    let mut closed = false;
    for _ in 0..50 {
        if !alive(&mut owner, orphaned).await {
            closed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(closed, "the connection left in a transaction was closed");
}

async fn backend_pid(conn: &mut apalis_sqlx::PgConnection) -> i32 {
    apalis_sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(conn)
        .await
        .expect("read backend pid")
}

async fn alive(owner: &mut sqlx::PgConnection, pid: i32) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1)")
        .bind(pid)
        .fetch_one(owner)
        .await
        .expect("read pg_stat_activity")
}

/// `ALTER ROLE ... PASSWORD` is cluster-global and sibling suites rewrite the
/// serving roles' (see apalis_schema_contract.rs), so state the ones this needs.
async fn reassert_password(url: &str) {
    let (role, password) = url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('@').next())
        .and_then(|credentials| credentials.split_once(':'))
        .expect("database URL carries role and password");
    let admin_url = std::env::var("CONSOLE_APALIS_ADMIN_DATABASE_URL")
        .expect("CONSOLE_APALIS_ADMIN_DATABASE_URL is required");
    let mut admin = sqlx::PgConnection::connect(&admin_url)
        .await
        .expect("connect as harness admin");
    let statement: String =
        sqlx::query_scalar("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text)")
            .bind(role)
            .bind(password)
            .fetch_one(&mut admin)
            .await
            .expect("build ALTER ROLE statement");
    // Built by PostgreSQL's format(%I, %L) from the harness URL's own role and password.
    sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
        .execute(&mut admin)
        .await
        .expect("re-assert the role password");
}
