// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Every migration must work for the deployed, non-superuser migration role.
use sqlx::{Connection, PgPool};

#[sqlx::test(migrations = false)]
async fn placement_migrations_run_as_console_app(pool: PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    let database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "ALTER DATABASE \"{}\" OWNER TO console_app",
        database.replace('"', "\"\"")
    )))
    .execute(&mut *conn)
    .await
    .unwrap();
    sqlx::query("GRANT CREATE ON SCHEMA public TO console_app")
        .execute(&mut *conn)
        .await
        .unwrap();
    // Use console_app for both identities; legacy rehearsals rotate login passwords.
    sqlx::query("SET SESSION AUTHORIZATION console_app")
        .execute(&mut *conn)
        .await
        .unwrap();
    let role: (String, String, bool) = sqlx::query_as("SELECT current_user::text, session_user::text, rolsuper FROM pg_roles WHERE rolname=current_user")
        .fetch_one(&mut *conn).await.unwrap();
    assert_eq!(role, ("console_app".into(), "console_app".into(), false));
    static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
    let result = MIGRATOR.run(&mut *conn).await;
    conn.detach().close().await.unwrap();
    result.unwrap();
    let grants: (bool, bool, bool) = sqlx::query_as(
        "SELECT has_schema_privilege('console_rt','hr_api','USAGE'), \
         has_function_privilege('console_rt','hr_api.route_placement_home_branch(uuid,uuid)','EXECUTE'), \
         has_schema_privilege('console_rt','hr_api','CREATE')")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(grants, (true, true, false));
}
