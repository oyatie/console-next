//! Serving and command pools: connection identity and timeout checks.

use crate::config::AppConfig;
use crate::config::SERVING_IDLE_IN_TRANSACTION_SESSION_TIMEOUT;
use crate::config::SERVING_STATEMENT_TIMEOUT;
use crate::config::SERVING_TRANSACTION_TIMEOUT;
use crate::config::db_pool::COMMAND_POOL_CONNECTIONS;
use crate::error::AppError;
use crate::state::db::RoleAttributes;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgConnection, PgPool, Row};

/// Open a deliberately small command pool and prove the URL resolves to the
/// expected PostgreSQL login. URL string inequality alone cannot establish
/// credential separation (aliases and DSN parameters can obscure identity), so
/// startup also checks both authenticated identities and role membership before
/// any router receives the pool.
pub(crate) async fn connect_command_pool(
    url: &str,
    expected_role: &str,
    env_name: &str,
    config: &AppConfig,
) -> Result<PgPool, AppError> {
    let after_connect_role = expected_role.to_owned();
    let after_connect_env = env_name.to_owned();
    let after_release_role = expected_role.to_owned();
    let after_release_env = env_name.to_owned();
    let pool = PgPoolOptions::new()
        .max_connections(COMMAND_POOL_CONNECTIONS)
        .acquire_timeout(config.db_pool.acquire_timeout)
        .after_connect(move |conn, _meta| {
            let expected_role = after_connect_role.clone();
            let env_name = after_connect_env.clone();
            Box::pin(async move {
                validate_database_connection_identity(conn, &env_name, &expected_role).await
            })
        })
        .after_release(move |conn, _meta| {
            let expected_role = after_release_role.clone();
            let env_name = after_release_env.clone();
            Box::pin(async move {
                reset_serving_database_connection(conn, &env_name, &expected_role).await
            })
        })
        .connect(url)
        .await
        .map_err(AppError::Database)?;
    validate_database_pool_identity(&pool, env_name, expected_role).await?;
    Ok(pool)
}

/// Whether the server holds an open transaction block on `conn`, whatever
/// sqlx's own depth says. One simple-protocol query: its implicit transaction
/// starts with the statement, so the two timestamps differ only inside a block
/// begun earlier (the extended protocol stamps each message, so it cannot tell).
pub(crate) async fn in_open_transaction(conn: &mut PgConnection) -> Result<bool, sqlx::Error> {
    sqlx::raw_sql("SELECT pg_catalog.transaction_timestamp() <> pg_catalog.statement_timestamp()")
        .fetch_one(conn)
        .await?
        .try_get(0)
}

/// Every pool's `after_release` runs this first. A connection released inside
/// an open transaction is refused (the hook's error hard-closes it): sqlx's
/// `begin` counts its depth only after BEGIN's reply, so a request future
/// dropped during that await (a 503 timeout) leaves the server in a transaction
/// sqlx does not track, and the next borrower's autocommit writes would run in
/// it, committed or rolled back by whoever ends it. An aborted transaction
/// fails the probe itself.
pub(crate) async fn reset_database_connection_state(
    conn: &mut PgConnection,
) -> Result<(), sqlx::Error> {
    if in_open_transaction(conn).await? {
        return Err(sqlx::Error::Protocol(
            "pooled connection released inside an open transaction".to_owned(),
        ));
    }
    sqlx::query("RESET SESSION AUTHORIZATION")
        .execute(&mut *conn)
        .await?;
    sqlx::query("RESET ROLE").execute(&mut *conn).await?;
    sqlx::query("RESET ALL").execute(&mut *conn).await?;
    Ok(())
}

pub(crate) async fn reset_serving_database_connection(
    conn: &mut PgConnection,
    env_name: &str,
    expected_role: &str,
) -> Result<bool, sqlx::Error> {
    // Any error from an `after_release` hook makes SQLx hard-close the
    // connection rather than return a partially cleaned session to the pool.
    reset_database_connection_state(conn).await?;
    Ok(
        validate_database_connection_identity(conn, env_name, expected_role)
            .await
            .is_ok(),
    )
}

pub(crate) async fn validate_database_connection_identity(
    conn: &mut PgConnection,
    env_name: &str,
    expected_role: &str,
) -> Result<(), sqlx::Error> {
    let readback =
        sqlx::query_as::<_, ServingDatabaseConnectionReadback>(serving_database_identity_query())
            .fetch_one(conn)
            .await?;
    ensure_expected_serving_database_identity(
        env_name,
        &readback.session_user,
        &readback.current_user,
        expected_role,
        RoleAttributes {
            can_login: readback.can_login,
            is_superuser: readback.is_superuser,
            bypasses_rls: readback.bypasses_rls,
            inherits_privileges: readback.inherits_privileges,
            can_create_db: readback.can_create_db,
            can_create_role: readback.can_create_role,
            can_replicate: readback.can_replicate,
        },
        readback.has_forbidden_membership_edge,
    )
    .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    ensure_expected_serving_database_timeouts(
        env_name,
        &readback.statement_timeout,
        &readback.idle_in_transaction_session_timeout,
        &readback.transaction_timeout,
        readback.statement_timeout_matches,
        readback.idle_in_transaction_session_timeout_matches,
        readback.transaction_timeout_matches,
    )
}

#[derive(sqlx::FromRow)]
struct ServingDatabaseConnectionReadback {
    session_user: String,
    current_user: String,
    can_login: bool,
    is_superuser: bool,
    bypasses_rls: bool,
    inherits_privileges: bool,
    can_create_db: bool,
    can_create_role: bool,
    can_replicate: bool,
    has_forbidden_membership_edge: bool,
    statement_timeout: String,
    idle_in_transaction_session_timeout: String,
    transaction_timeout: String,
    statement_timeout_matches: bool,
    idle_in_transaction_session_timeout_matches: bool,
    transaction_timeout_matches: bool,
}

pub(crate) fn serving_database_identity_query() -> &'static str {
    r#"SELECT session_user::text,
              current_user::text,
              authenticated.rolcanlogin AS can_login,
              authenticated.rolsuper AS is_superuser,
              authenticated.rolbypassrls AS bypasses_rls,
              authenticated.rolinherit AS inherits_privileges,
              authenticated.rolcreatedb AS can_create_db,
              authenticated.rolcreaterole AS can_create_role,
              authenticated.rolreplication AS can_replicate,
              EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_roles AS candidate
                  WHERE candidate.rolname <> session_user
                    AND pg_catalog.pg_has_role(session_user, candidate.oid, 'MEMBER')
              ) OR EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_auth_members AS membership
                  WHERE membership.roleid = authenticated.oid
              ) AS has_forbidden_membership_edge,
              current_setting('statement_timeout') AS statement_timeout,
              current_setting('idle_in_transaction_session_timeout')
                  AS idle_in_transaction_session_timeout,
              current_setting('transaction_timeout') AS transaction_timeout,
              current_setting('statement_timeout')::interval = interval '30 seconds'
                  AS statement_timeout_matches,
              current_setting('idle_in_transaction_session_timeout')::interval = interval '30 seconds'
                  AS idle_in_transaction_session_timeout_matches,
              current_setting('transaction_timeout')::interval = interval '45 seconds'
                  AS transaction_timeout_matches
       FROM pg_catalog.pg_roles AS authenticated
       WHERE authenticated.rolname = session_user"#
}

pub(crate) async fn validate_database_pool_identity(
    pool: &PgPool,
    env_name: &str,
    expected_role: &str,
) -> Result<(), AppError> {
    let mut conn = pool.acquire().await.map_err(AppError::Database)?;

    validate_database_connection_identity(&mut conn, env_name, expected_role)
        .await
        .map_err(AppError::Database)
}

pub(crate) fn ensure_expected_serving_database_identity(
    env_name: &str,
    session_user: &str,
    current_user: &str,
    expected_role: &str,
    attributes: RoleAttributes,
    has_forbidden_membership_edge: bool,
) -> Result<(), AppError> {
    if session_user != expected_role || current_user != expected_role {
        return Err(AppError::Config(format!(
            "{env_name} must authenticate directly as PostgreSQL role {expected_role:?}; \
             session_user={session_user:?}, current_user={current_user:?}"
        )));
    }
    if attributes != RoleAttributes::HARDENED_LOGIN {
        return Err(AppError::Config(format!(
            "{env_name} PostgreSQL role {expected_role:?} must be LOGIN, NOINHERIT, NOSUPERUSER, \
             NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, and NOREPLICATION"
        )));
    }
    if has_forbidden_membership_edge {
        return Err(AppError::Config(format!(
            "{env_name} PostgreSQL role {expected_role:?} must not participate in any direct or inherited role membership edge"
        )));
    }
    Ok(())
}

pub(crate) fn ensure_expected_serving_database_timeouts(
    env_name: &str,
    statement_timeout: &str,
    idle_in_transaction_session_timeout: &str,
    transaction_timeout: &str,
    statement_timeout_matches: bool,
    idle_in_transaction_session_timeout_matches: bool,
    transaction_timeout_matches: bool,
) -> Result<(), sqlx::Error> {
    if statement_timeout_matches
        && idle_in_transaction_session_timeout_matches
        && transaction_timeout_matches
    {
        return Ok(());
    }

    Err(sqlx::Error::Protocol(format!(
        "{env_name} serving connection timeout readback failed: \
         statement_timeout={statement_timeout:?}, \
         idle_in_transaction_session_timeout={idle_in_transaction_session_timeout:?}, \
         transaction_timeout={transaction_timeout:?}; \
         required statement_timeout={SERVING_STATEMENT_TIMEOUT}, \
         idle_in_transaction_session_timeout={SERVING_IDLE_IN_TRANSACTION_SESSION_TIMEOUT}, \
         and transaction_timeout={SERVING_TRANSACTION_TIMEOUT}"
    )))
}

// As with `readiness_tests`: the single test here is feature-gated, so the
// module has no non-featured content to compile.
#[cfg(all(test, feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod serving_database_timeout_tests {
    use std::time::Duration;

    use sqlx::{PgPool, postgres::PgPoolOptions};

    use super::{reset_serving_database_connection, validate_database_connection_identity};

    async fn assert_serving_timeouts(pool: &PgPool) {
        let (statement, idle_in_transaction, transaction): (String, String, String) =
            sqlx::query_as(
                r#"SELECT current_setting('statement_timeout'),
                          current_setting('idle_in_transaction_session_timeout'),
                          current_setting('transaction_timeout')"#,
            )
            .fetch_one(pool)
            .await
            .expect("serving timeouts read back");

        assert_eq!(statement, "30s");
        assert_eq!(idle_in_transaction, "30s");
        assert_eq!(transaction, "45s");
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrations = false)]
    async fn serving_pool_rejects_overrides_and_restores_role_defaults_after_release(pool: PgPool) {
        let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&pool)
            .await
            .expect("test backend pid reads");
        let role = format!("console_serving_timeout_test_{backend_pid}");
        let password = "serving-timeout-test-password";
        let quoted_database: String = sqlx::query_scalar("SELECT quote_ident(current_database())")
            .fetch_one(&pool)
            .await
            .expect("test database name quotes");

        // `role` is a fixed prefix plus the numeric backend PID, `password` is
        // a test literal, and PostgreSQL produced `quoted_database` with
        // quote_ident; no external input reaches this audited dynamic DDL.
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"CREATE ROLE {role}
                    LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION
                    PASSWORD '{password}';
               ALTER ROLE {role} SET statement_timeout = '30s';
               ALTER ROLE {role} SET idle_in_transaction_session_timeout = '30s';
               ALTER ROLE {role} SET transaction_timeout = '45s';
               GRANT CONNECT ON DATABASE {quoted_database} TO {role};"#,
        )))
        .execute(&pool)
        .await
        .expect("isolated hardened serving role provisions");

        let connect_options = pool
            .connect_options()
            .as_ref()
            .clone()
            .username(&role)
            .password(password);
        let after_connect_role = role.clone();
        let after_release_role = role.clone();
        let serving_pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(10))
            .after_connect(move |conn, _meta| {
                let expected_role = after_connect_role.clone();
                Box::pin(async move {
                    validate_database_connection_identity(
                        conn,
                        "TEST_SERVING_DATABASE_URL",
                        &expected_role,
                    )
                    .await
                })
            })
            .after_release(move |conn, _meta| {
                let expected_role = after_release_role.clone();
                Box::pin(async move {
                    reset_serving_database_connection(
                        conn,
                        "TEST_SERVING_DATABASE_URL",
                        &expected_role,
                    )
                    .await
                })
            })
            .connect_with(connect_options.clone())
            .await
            .expect("exact role defaults pass serving startup validation");

        assert_serving_timeouts(&serving_pool).await;
        {
            let mut connection = serving_pool
                .acquire()
                .await
                .expect("serving connection acquires for poisoning");
            sqlx::raw_sql(
                r#"SET SESSION statement_timeout = '1s';
                   SET SESSION idle_in_transaction_session_timeout = '2s';
                   SET SESSION transaction_timeout = '3s';"#,
            )
            .execute(&mut *connection)
            .await
            .expect("serving session timeout poison applies");
        }
        assert_serving_timeouts(&serving_pool).await;
        serving_pool.close().await;

        let _startup_override = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(3))
            .after_connect({
                let role = role.clone();
                move |conn, _meta| {
                    let role = role.clone();
                    Box::pin(async move {
                        validate_database_connection_identity(
                            conn,
                            "TEST_SERVING_DATABASE_URL",
                            &role,
                        )
                        .await
                    })
                }
            })
            .connect_with(
                connect_options
                    .clone()
                    .options([("statement_timeout", "29s")]),
            )
            .await
            .expect_err("startup options must not override serving role defaults");

        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "ALTER ROLE {role} SET transaction_timeout = '44s';"
        )))
        .execute(&pool)
        .await
        .expect("isolated role default drifts");
        let _wrong_default = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(3))
            .after_connect({
                let role = role.clone();
                move |conn, _meta| {
                    let role = role.clone();
                    Box::pin(async move {
                        validate_database_connection_identity(
                            conn,
                            "TEST_SERVING_DATABASE_URL",
                            &role,
                        )
                        .await
                    })
                }
            })
            .connect_with(connect_options)
            .await
            .expect_err("wrong serving role default must fail startup");

        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "REVOKE CONNECT ON DATABASE {quoted_database} FROM {role}; DROP ROLE {role};"
        )))
        .execute(&pool)
        .await
        .expect("isolated serving role drops");
    }
}
