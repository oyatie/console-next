//! Migration connection: owner identity and lock/statement budgets.

use crate::run::migrate::MIGRATION_LOCK_TIMEOUT;
use crate::run::migrate::MIGRATION_STATEMENT_TIMEOUT;
use crate::state::db::RoleAttributes;
use crate::state::db::RoleMembership;
use crate::state::db::SubordinateRoleContract;
use crate::state::db::ensure_expected_migration_database_identity;
use crate::state::db::serving::reset_database_connection_state;
use sqlx::PgConnection;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

async fn validate_migration_database_connection(
    conn: &mut PgConnection,
) -> Result<(), sqlx::Error> {
    let (
        session_user,
        current_user,
        database_owner,
        can_login,
        is_superuser,
        bypasses_rls,
        inherits_privileges,
        can_create_db,
        can_create_role,
        can_replicate,
    ): (
        String,
        String,
        String,
        bool,
        bool,
        bool,
        bool,
        bool,
        bool,
        bool,
    ) = sqlx::query_as(
        r#"SELECT session_user::text,
                  current_user::text,
                  pg_catalog.pg_get_userbyid(database.datdba),
                  authenticated.rolcanlogin,
                  authenticated.rolsuper,
                  authenticated.rolbypassrls,
                  authenticated.rolinherit,
                  authenticated.rolcreatedb,
                  authenticated.rolcreaterole,
                  authenticated.rolreplication
           FROM pg_catalog.pg_roles AS authenticated
           JOIN pg_catalog.pg_database AS database
             ON database.datname = current_database()
           WHERE authenticated.rolname = session_user"#,
    )
    .fetch_one(&mut *conn)
    .await?;

    let memberships = sqlx::query_as::<_, (String, bool, bool, bool)>(
        r#"SELECT granted.rolname,
                  membership.admin_option,
                  membership.inherit_option,
                  membership.set_option
           FROM pg_catalog.pg_auth_members AS membership
           JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
           JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
           WHERE member.rolname = 'console_app'
           ORDER BY granted.rolname"#,
    )
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(
        |(role_name, admin_option, inherit_option, set_option)| RoleMembership {
            role_name,
            admin_option,
            inherit_option,
            set_option,
        },
    )
    .collect::<Vec<_>>();

    let subordinate_roles =
        sqlx::query_as::<_, (String, bool, bool, bool, bool, bool, bool, bool, bool)>(
            r#"SELECT subordinate.rolname,
                  subordinate.rolcanlogin,
                  subordinate.rolsuper,
                  subordinate.rolbypassrls,
                  subordinate.rolinherit,
                  subordinate.rolcreatedb,
                  subordinate.rolcreaterole,
                  subordinate.rolreplication,
                  EXISTS (
                      SELECT 1
                      FROM pg_catalog.pg_roles AS candidate
                      WHERE candidate.rolname <> subordinate.rolname
                        AND pg_catalog.pg_has_role(subordinate.oid, candidate.oid, 'MEMBER')
                  )
           FROM pg_catalog.pg_roles AS subordinate
           WHERE subordinate.rolname IN ('console_leave_definer', 'console_ontology_writer')
           ORDER BY subordinate.rolname"#,
        )
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .map(
            |(
                role_name,
                can_login,
                is_superuser,
                bypasses_rls,
                inherits_privileges,
                can_create_db,
                can_create_role,
                can_replicate,
                has_unexpected_membership,
            )| SubordinateRoleContract {
                role_name,
                attributes: RoleAttributes {
                    can_login,
                    is_superuser,
                    bypasses_rls,
                    inherits_privileges,
                    can_create_db,
                    can_create_role,
                    can_replicate,
                },
                has_unexpected_membership,
            },
        )
        .collect::<Vec<_>>();

    let has_unexpected_application_membership_edge: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_auth_members AS membership
               JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
               JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
               WHERE (
                   granted.rolname IN (
                       'console_app', 'console_rt', 'console_leave_definer', 'console_leave_cmd',
                       'console_ontology_writer', 'console_ontology_cmd', 'console_platform_force_cmd'
                   )
                   OR member.rolname IN (
                       'console_app', 'console_rt', 'console_leave_definer', 'console_leave_cmd',
                       'console_ontology_writer', 'console_ontology_cmd', 'console_platform_force_cmd'
                   )
               )
               AND NOT (
                   member.rolname = 'console_app'
                   AND granted.rolname IN ('console_leave_definer', 'console_ontology_writer')
                   AND NOT membership.admin_option
                   AND membership.inherit_option
                   AND membership.set_option
               )
           )"#,
    )
    .fetch_one(&mut *conn)
    .await?;

    // Database ownership implicitly makes console_app a member of
    // pg_database_owner. Apart from that safe database-local capability and
    // the two direct SET edges required to transfer SECURITY DEFINER function
    // ownership, the migration login must not inherit any effective role.
    let has_unexpected_effective_migration_membership: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_roles AS candidate
               WHERE candidate.rolname <> session_user
                 AND candidate.rolname NOT IN (
                     'pg_database_owner', 'console_leave_definer', 'console_ontology_writer'
                 )
                 AND pg_catalog.pg_has_role(session_user, candidate.oid, 'MEMBER')
           )"#,
    )
    .fetch_one(&mut *conn)
    .await?;

    ensure_expected_migration_database_identity(
        &session_user,
        &current_user,
        &database_owner,
        RoleAttributes {
            can_login,
            is_superuser,
            bypasses_rls,
            inherits_privileges,
            can_create_db,
            can_create_role,
            can_replicate,
        },
        &memberships,
        &subordinate_roles,
        has_unexpected_application_membership_edge || has_unexpected_effective_migration_membership,
    )
    .map_err(|error| sqlx::Error::Protocol(error.to_string()))
}

fn ensure_expected_migration_database_budgets(
    lock_timeout: &str,
    statement_timeout: &str,
    lock_timeout_matches: bool,
    statement_timeout_matches: bool,
) -> Result<(), sqlx::Error> {
    if lock_timeout_matches && statement_timeout_matches {
        return Ok(());
    }

    Err(sqlx::Error::Protocol(format!(
        "migration connection budget readback failed: lock_timeout={lock_timeout:?}, \
         statement_timeout={statement_timeout:?}; required lock_timeout={MIGRATION_LOCK_TIMEOUT} \
         and statement_timeout={MIGRATION_STATEMENT_TIMEOUT}"
    )))
}

pub(crate) async fn enforce_migration_database_budgets(
    conn: &mut PgConnection,
) -> Result<(), sqlx::Error> {
    sqlx::query("SET SESSION lock_timeout = '5s'")
        .execute(&mut *conn)
        .await?;
    sqlx::query("SET SESSION statement_timeout = '60s'")
        .execute(&mut *conn)
        .await?;

    let (lock_timeout, statement_timeout, lock_timeout_matches, statement_timeout_matches): (
        String,
        String,
        bool,
        bool,
    ) = sqlx::query_as(
        r#"SELECT current_setting('lock_timeout'),
                  current_setting('statement_timeout'),
                  current_setting('lock_timeout')::interval = interval '5 seconds',
                  current_setting('statement_timeout')::interval = interval '60 seconds'"#,
    )
    .fetch_one(&mut *conn)
    .await?;

    ensure_expected_migration_database_budgets(
        &lock_timeout,
        &statement_timeout,
        lock_timeout_matches,
        statement_timeout_matches,
    )
}

pub(crate) async fn prepare_migration_database_connection(
    conn: &mut PgConnection,
) -> Result<(), sqlx::Error> {
    enforce_migration_database_budgets(conn).await?;
    validate_migration_database_connection(conn).await
}

async fn reset_migration_database_connection(conn: &mut PgConnection) -> Result<bool, sqlx::Error> {
    reset_database_connection_state(conn).await?;
    enforce_migration_database_budgets(conn).await?;
    Ok(true)
}

pub(crate) fn migration_database_pool_options() -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(|conn, _meta| {
            Box::pin(async move { prepare_migration_database_connection(conn).await })
        })
        .after_release(|conn, _meta| {
            Box::pin(async move { reset_migration_database_connection(conn).await })
        })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod migration_database_budget_tests {
    #[cfg(feature = "test-postgres")]
    use std::time::Duration;

    #[cfg(feature = "test-postgres")]
    use sqlx::{PgPool, postgres::PgPoolOptions};

    #[cfg(not(feature = "test-postgres"))]
    use super::ensure_expected_migration_database_budgets;
    #[cfg(feature = "test-postgres")]
    use super::{enforce_migration_database_budgets, reset_migration_database_connection};

    // The helpers below serve only the `test-postgres` test; the readback tests
    // run without it, so each item carries its own feature gate.
    #[cfg(feature = "test-postgres")]
    fn isolated_owner_budget_pool_options() -> PgPoolOptions {
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(10))
            .after_connect(|conn, _meta| {
                Box::pin(async move { enforce_migration_database_budgets(conn).await })
            })
            .after_release(|conn, _meta| {
                Box::pin(async move { reset_migration_database_connection(conn).await })
            })
    }

    #[cfg(feature = "test-postgres")]
    async fn cluster_identity_snapshot(pool: &PgPool) -> String {
        sqlx::query_scalar(
            r#"SELECT jsonb_build_object(
                    'database_owner', pg_catalog.pg_get_userbyid(database.datdba),
                    'roles', COALESCE((
                        SELECT jsonb_agg(to_jsonb(role_state) ORDER BY role_state.rolname)
                        FROM (
                            SELECT role.rolname,
                                   role.rolpassword,
                                   role.rolcanlogin,
                                   role.rolsuper,
                                   role.rolinherit,
                                   role.rolcreaterole,
                                   role.rolcreatedb,
                                   role.rolreplication,
                                   role.rolbypassrls
                            FROM pg_catalog.pg_authid AS role
                            WHERE role.rolname IN (
                                'console_app', 'console_leave_definer', 'console_ontology_writer'
                            )
                        ) AS role_state
                    ), '[]'::jsonb),
                    'memberships', COALESCE((
                        SELECT jsonb_agg(to_jsonb(membership_state)
                                         ORDER BY membership_state.member,
                                                  membership_state.granted_role)
                        FROM (
                            SELECT member.rolname AS member,
                                   granted.rolname AS granted_role,
                                   membership.admin_option,
                                   membership.inherit_option,
                                   membership.set_option
                            FROM pg_catalog.pg_auth_members AS membership
                            JOIN pg_catalog.pg_roles AS member
                              ON member.oid = membership.member
                            JOIN pg_catalog.pg_roles AS granted
                              ON granted.oid = membership.roleid
                            WHERE member.rolname IN (
                                'console_app', 'console_leave_definer', 'console_ontology_writer'
                            ) OR granted.rolname IN (
                                'console_app', 'console_leave_definer', 'console_ontology_writer'
                            )
                        ) AS membership_state
                    ), '[]'::jsonb)
                )::text
                FROM pg_catalog.pg_database AS database
                WHERE database.datname = current_database()"#,
        )
        .fetch_one(pool)
        .await
        .expect("cluster identity snapshot reads")
    }

    #[cfg(feature = "test-postgres")]
    async fn assert_migration_session(pool: &PgPool, expected_user: &str) {
        let (session_user, current_user, lock_timeout, statement_timeout): (
            String,
            String,
            String,
            String,
        ) = sqlx::query_as(
            r#"SELECT session_user::text,
                      current_user::text,
                      current_setting('lock_timeout'),
                      current_setting('statement_timeout')"#,
        )
        .fetch_one(pool)
        .await
        .expect("migration session settings read back");

        assert_eq!(session_user, expected_user);
        assert_eq!(current_user, expected_user);
        assert_eq!(lock_timeout, "5s");
        assert_eq!(statement_timeout, "1min");
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn migration_database_budgets_accept_exact_readback() {
        assert!(ensure_expected_migration_database_budgets("5s", "1min", true, true).is_ok());
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn migration_database_budgets_reject_any_readback_mismatch() {
        for (lock_timeout_matches, statement_timeout_matches) in
            [(false, true), (true, false), (false, false)]
        {
            let error = ensure_expected_migration_database_budgets(
                "7s",
                "90s",
                lock_timeout_matches,
                statement_timeout_matches,
            )
            .unwrap_err();
            let message = error.to_string();

            assert!(message.contains("lock_timeout=\"7s\""));
            assert!(message.contains("statement_timeout=\"90s\""));
            assert!(message.contains("required lock_timeout=5s and statement_timeout=60s"));
        }
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrations = false)]
    async fn migration_pool_applies_and_restores_session_budgets(pool: PgPool) {
        // Snapshot before the test body performs any session mutation. This
        // regression deliberately runs with no migrations so it cannot alter
        // cluster-global role defaults or memberships.
        let identity_before = cluster_identity_snapshot(&pool).await;
        let expected_user: String = sqlx::query_scalar("SELECT session_user::text")
            .fetch_one(&pool)
            .await
            .expect("isolated test database owner reads");
        let connect_options = pool.connect_options().as_ref().clone();
        let migration_pool = isolated_owner_budget_pool_options()
            .connect_with(connect_options)
            .await
            .expect("migration budget pool connects as isolated test database owner");

        assert_migration_session(&migration_pool, &expected_user).await;

        {
            let mut connection = migration_pool
                .acquire()
                .await
                .expect("migration connection acquires for poisoning");
            sqlx::raw_sql(
                r#"
                SET SESSION lock_timeout = '13s';
                SET SESSION statement_timeout = '17s';
                SET SESSION AUTHORIZATION pg_database_owner;
                "#,
            )
            .execute(&mut *connection)
            .await
            .expect(
                "isolated database owner can safely poison only its session authorization and budgets",
            );
        }

        assert_migration_session(&migration_pool, &expected_user).await;
        migration_pool.close().await;
        assert_eq!(cluster_identity_snapshot(&pool).await, identity_before);
    }
}
