use std::borrow::Cow;

use sqlx::migrate::{AppliedMigration, Migration, MigrationType};

use super::{install_migrator, one_lineage};

fn migration(version: i64, sql: &'static str) -> Migration {
    Migration::new(
        version,
        Cow::Borrowed("m"),
        MigrationType::Simple,
        sqlx::SqlStr::from_static(sql),
        false,
    )
}

fn applied(migrations: &[Migration]) -> Vec<AppliedMigration> {
    migrations
        .iter()
        .map(|m| AppliedMigration {
            version: m.version,
            checksum: m.checksum.clone(),
        })
        .collect()
}

#[test]
fn an_older_binary_on_a_newer_schema_is_one_lineage() {
    let n = vec![
        migration(1, "SELECT 1"),
        migration(2, "SELECT 2"),
        migration(3, "SELECT 3"),
    ];
    let older = install_migrator(n[..2].to_vec());
    assert!(
        one_lineage(&applied(&n), &older),
        "N-1 binary on an N schema (BG-4)"
    );
    assert!(
        older.ignore_missing,
        "sqlx must not refuse the versions it does not embed"
    );
    let newer = install_migrator(n.clone());
    assert!(
        one_lineage(&applied(&n[..1]), &newer),
        "N binary on an N-1 schema"
    );
}

#[test]
fn a_changed_or_foreign_migration_is_not_one_lineage() {
    let n = vec![migration(1, "SELECT 1"), migration(2, "SELECT 2")];
    let edited = install_migrator(vec![migration(1, "SELECT 1"), migration(2, "SELECT 22")]);
    assert!(!one_lineage(&applied(&n), &edited), "a checksum mismatch");
    let gap = install_migrator(vec![migration(1, "SELECT 1"), migration(3, "SELECT 3")]);
    assert!(!one_lineage(&applied(&n), &gap), "a version mismatch");
}

/// sqlx's own run, on Postgres: the older embedded list applies nothing and
/// does not fail with `VersionMissing` on the newer ledger.
#[cfg(feature = "test-postgres")]
#[sqlx::test(migrations = false)]
async fn an_older_migrator_runs_clean_on_a_newer_ledger(pool: sqlx::PgPool) {
    let n = vec![
        migration(1, "CREATE TABLE bg4_a (id int)"),
        migration(2, "CREATE TABLE bg4_b (id int)"),
    ];
    let mut conn = pool.acquire().await.unwrap();
    install_migrator(n.clone()).run(&mut *conn).await.unwrap();
    install_migrator(n[..1].to_vec())
        .run(&mut *conn)
        .await
        .expect("N-1 migrate on an N schema");
    let mut strict = install_migrator(n[..1].to_vec());
    strict.ignore_missing = false;
    assert!(
        strict.run(&mut *conn).await.is_err(),
        "without ignore_missing sqlx refuses (the bug)"
    );
}

#[test]
fn timestamps_may_land_out_of_order_without_losing_checksum_or_legacy_checks() {
    let legacy = migration(1, "SELECT 1");
    let early = migration(20261012110000, "SELECT 11");
    let late = migration(20261012120000, "SELECT 12");
    let old = install_migrator(vec![legacy.clone(), late.clone()]);
    let new = install_migrator(vec![legacy.clone(), early.clone(), late.clone()]);
    let mixed_upgrade =
        install_migrator(vec![legacy.clone(), migration(2, "SELECT 2"), late.clone()]);
    assert!(
        one_lineage(&applied(&[legacy.clone(), late.clone()]), &mixed_upgrade),
        "an in-flight reserved legacy version can land after a timestamp"
    );
    assert!(one_lineage(&applied(&[legacy.clone(), late.clone()]), &new));
    assert!(one_lineage(
        &applied(&[legacy.clone(), early, late.clone()]),
        &old
    ));
    assert!(
        !one_lineage(&applied(std::slice::from_ref(&late)), &new),
        "legacy history is required"
    );
    assert!(
        !one_lineage(
            &applied(&[legacy, migration(late.version, "SELECT 99")]),
            &new
        ),
        "timestamp checksum drift"
    );
}

#[cfg(feature = "test-postgres")]
#[sqlx::test(migrations = false)]
async fn sqlx_applies_late_lower_timestamps_and_refuses_drift(
    pool: sqlx::PgPool,
) -> Result<(), Box<dyn std::error::Error>> {
    let legacy = migration(1, "SELECT 1");
    let early = migration(
        20261012110000,
        "CREATE TABLE timestamp_probe_early (value int)",
    );
    let late = migration(
        20261012120000,
        "CREATE TABLE timestamp_probe_late (value int)",
    );
    let old = install_migrator(vec![legacy.clone(), late.clone()]);
    let new = install_migrator(vec![legacy.clone(), early, late.clone()]);
    old.run(&pool).await?;
    new.run(&pool).await?;
    old.run(&pool)
        .await
        .expect("N-1 rollback retains both timestamp additions");
    new.run(&pool).await?;
    // A replayed CREATE TABLE would have failed the run above: each version applied once.
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_tables WHERE tablename IN ('timestamp_probe_early', 'timestamp_probe_late')",
    )
    // rls-arming: ok pg_tables is the global system catalog in a disposable test database, no RLS
    .fetch_one(&pool)
    .await?;
    assert_eq!(
        count, 2,
        "both timestamp additions applied, the late lower one included"
    );
    let changed = install_migrator(vec![legacy, migration(late.version, "SELECT 99")]);
    assert!(
        changed.run(&pool).await.is_err(),
        "SQLx refuses a changed checksum"
    );
    Ok(())
}

/// Production-shaped, on the real migration tree: a release has applied every timestamp
/// migration, then the next release brings a reserved four-digit version (the held
/// 0362-0364 class). The lineage check admits it, SQLx applies it after the timestamps,
/// and the previous release's migrate still runs clean on the result (BG-4).
#[cfg(feature = "test-postgres")]
#[sqlx::test(migrations = false)]
async fn a_reserved_legacy_version_lands_after_released_timestamps(
    pool: sqlx::PgPool,
) -> Result<(), Box<dyn std::error::Error>> {
    use sqlx::migrate::Migrate;
    let released: Vec<Migration> = crate::MIGRATOR.iter().cloned().collect();
    assert!(
        released.iter().any(|m| m.version >= 10_000_000_000_000),
        "the tree carries timestamp versions"
    );
    let reserved = released
        .iter()
        .map(|m| m.version)
        .filter(|v| *v < 10_000)
        .max()
        .ok_or("no legacy version")?
        + 1;
    let mut next = released.clone();
    next.push(migration(
        reserved,
        "CREATE TABLE reserved_late_probe (id int)",
    ));
    next.sort_by_key(|m| m.version);
    let (released, next) = (install_migrator(released), install_migrator(next));
    let mut conn = pool.acquire().await?;
    released.run(&mut *conn).await?;
    for (migrator, label) in [(&next, "next release"), (&released, "N-1 rollback")] {
        let applied = conn.list_applied_migrations("_sqlx_migrations").await?;
        assert!(one_lineage(&applied, migrator), "{label} is one lineage");
        migrator.run(&mut *conn).await?;
    }
    let ledger: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *conn)
            .await?;
    let expected: Vec<i64> = next.iter().map(|m| m.version).collect();
    assert_eq!(ledger, expected, "every version applied exactly once");
    Ok(())
}
