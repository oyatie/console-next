//! The runtime pool's release hook. sqlx's `begin` counts its depth only after
//! BEGIN's reply, so a request dropped during that await (the API's 503
//! timeout around an enqueue) leaves the server in a transaction sqlx does not
//! track; such a connection is closed (the hook's error) instead of pooled,
//! where the next borrower's statements would run inside it. Same probe as the
//! app's pools (app/src/state/db/serving.rs): one simple-protocol query, whose
//! implicit transaction starts with the statement.

use apalis_sqlx::{Executor as _, Row as _};

pub(crate) async fn reset_runtime_connection(
    conn: &mut apalis_sqlx::PgConnection,
) -> Result<bool, apalis_sqlx::Error> {
    // A bare &str has no arguments, so sqlx sends it as a simple Query.
    let in_transaction: bool = (&mut *conn)
        .fetch_one("SELECT pg_catalog.transaction_timestamp() <> pg_catalog.statement_timestamp()")
        .await?
        .try_get(0)?;
    if in_transaction {
        return Err(apalis_sqlx::Error::Protocol(
            "pooled connection released inside an open transaction".to_owned(),
        ));
    }
    apalis_sqlx::query("RESET SESSION AUTHORIZATION")
        .execute(&mut *conn)
        .await?;
    apalis_sqlx::query("RESET ROLE").execute(&mut *conn).await?;
    apalis_sqlx::query("RESET ALL").execute(&mut *conn).await?;
    Ok(crate::validate_apalis_runtime_connection(conn)
        .await
        .is_ok())
}
