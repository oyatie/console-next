//! The release guard in `reset_database_connection_state`: a connection
//! handed back inside a transaction sqlx does not track never reaches the next
//! borrower, and a normal release (a dropped `Transaction` included) keeps it.

use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, PgPool};

use super::serving::{in_open_transaction, reset_database_connection_state};

async fn backend_pid(conn: &mut PgConnection) -> sqlx::Result<i32> {
    sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(conn)
        .await
}

#[sqlx::test(migrations = false)]
async fn a_connection_released_inside_an_untracked_transaction_is_closed(
    pool: PgPool,
) -> sqlx::Result<()> {
    let guarded = PgPoolOptions::new()
        .max_connections(1)
        .after_release(|conn, _meta| {
            Box::pin(async move { reset_database_connection_state(conn).await.map(|()| true) })
        })
        .connect_with(pool.connect_options().as_ref().clone())
        .await?;

    // A clean release and a dropped (rolled back) transaction keep the connection.
    let mut conn = guarded.acquire().await?;
    let first = backend_pid(&mut conn).await?;
    drop(conn.begin().await?);
    drop(conn);
    let mut conn = guarded.acquire().await?;
    assert_eq!(
        backend_pid(&mut conn).await?,
        first,
        "a clean release is reused"
    );

    // What a request future dropped inside `begin` leaves behind: the server ran
    // BEGIN, sqlx's depth is still 0.
    sqlx::raw_sql("BEGIN").execute(&mut *conn).await?;
    assert!(!conn.is_in_transaction(), "sqlx does not track a raw BEGIN");
    assert!(in_open_transaction(&mut conn).await?, "the server does");
    drop(conn);

    let mut conn = guarded.acquire().await?;
    assert_ne!(
        backend_pid(&mut conn).await?,
        first,
        "the connection left in a transaction was closed"
    );
    assert!(
        !in_open_transaction(&mut conn).await?,
        "the next borrower starts outside any transaction"
    );
    Ok(())
}
