//! Fault injection for the TS-15 chaos suites: a test-owned trigger makes the
//! backend that fires it terminate itself, so the open transaction dies
//! mid-flight exactly where a crash or `pg_terminate_backend` would cut it.
//! Nothing here touches product code; `disarm` drops every trigger it made.
#![allow(dead_code)]

use sqlx::PgPool;

/// Arms `chaos_kill` on `table` (`AFTER INSERT` / `AFTER UPDATE OF col`, row
/// level, filtered by `when`). The firing backend sends itself SIGTERM; the
/// sleep is where the FATAL lands, so nothing after the trigger runs.
pub async fn arm_kill(pool: &PgPool, table: &str, event: &str, when: &str) {
    arm(
        pool,
        table,
        event,
        when,
        "PERFORM pg_terminate_backend(pg_backend_pid()); PERFORM pg_sleep(5);",
    )
    .await;
}

/// Arms `chaos_slow`: every matching row waits `seconds` (a long statement to
/// time out or to kill from outside).
pub async fn arm_slow(pool: &PgPool, table: &str, event: &str, when: &str, seconds: f64) {
    arm(
        pool,
        table,
        event,
        when,
        &format!("PERFORM pg_sleep({seconds});"),
    )
    .await;
}

async fn arm(pool: &PgPool, table: &str, event: &str, when: &str, body: &str) {
    let name = format!("chaos_{}", table.replace('.', "_"));
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE OR REPLACE FUNCTION {name}_fn() RETURNS trigger LANGUAGE plpgsql \
         SECURITY DEFINER SET search_path = pg_catalog AS $$ BEGIN {body} RETURN NULL; END $$; \
         DROP TRIGGER IF EXISTS {name} ON {table}; \
         CREATE TRIGGER {name} {event} ON {table} FOR EACH ROW WHEN ({when}) EXECUTE FUNCTION {name}_fn();"
    )))
    .execute(pool)
    .await
    .unwrap();
}

/// Drops every chaos trigger and function this suite created.
pub async fn disarm(pool: &PgPool) {
    sqlx::raw_sql(
        "DO $$ DECLARE t record; BEGIN \
           FOR t IN SELECT tgname, tgrelid::regclass AS rel FROM pg_trigger WHERE tgname LIKE 'chaos\\_%' LOOP \
             EXECUTE format('DROP TRIGGER %I ON %s', t.tgname, t.rel); \
           END LOOP; \
           FOR t IN SELECT oid::regprocedure AS f FROM pg_proc WHERE proname LIKE 'chaos\\_%\\_fn' LOOP \
             EXECUTE format('DROP FUNCTION %s', t.f); \
           END LOOP; END $$;",
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Terminates, from outside, every backend of this database running a query
/// that contains `needle` (a restart as the app sees it). Returns how many.
pub async fn kill_running(pool: &PgPool, needle: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) FROM pg_stat_activity \
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' \
           AND query ILIKE '%' || $1 || '%' AND query NOT ILIKE '%pg_stat_activity%'",
    )
    .bind(needle)
    .fetch_one(pool)
    .await
    .unwrap()
}
