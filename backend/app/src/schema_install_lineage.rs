use sqlx::migrate::{AppliedMigration, Migrator};
use std::collections::BTreeMap;

// Four-digit legacy versions stay ordered; new UTC timestamp versions are additive.
const TIMESTAMP_VERSION: i64 = 10_000_000_000_000;

pub(super) fn one_lineage(applied: &[AppliedMigration], migrator: &Migrator) -> bool {
    let legacy = applied
        .iter()
        .filter(|entry| entry.version < TIMESTAMP_VERSION);
    let expected = migrator
        .iter()
        .filter(|entry| entry.version < TIMESTAMP_VERSION);
    if !legacy.zip(expected).all(|(actual, expected)| {
        actual.version == expected.version && actual.checksum == expected.checksum
    }) {
        return false;
    }
    // Timestamp additions need a legacy lineage, but pending reserved legacy
    // versions may still arrive during the naming transition.
    if applied
        .iter()
        .any(|entry| entry.version >= TIMESTAMP_VERSION)
        && !applied
            .iter()
            .any(|entry| entry.version < TIMESTAMP_VERSION)
        && migrator
            .iter()
            .any(|entry| entry.version < TIMESTAMP_VERSION)
    {
        return false;
    }
    let known: BTreeMap<_, _> = migrator
        .iter()
        .map(|entry| (entry.version, &entry.checksum))
        .collect();
    applied
        .iter()
        .filter(|entry| entry.version >= TIMESTAMP_VERSION)
        .all(|actual| {
            known
                .get(&actual.version)
                .is_none_or(|checksum| **checksum == actual.checksum)
        })
    // Unknown timestamp entries are allowed for N-1 rollback. Release migration-lint
    // separately forbids deleting released files; known checksums always fail closed.
}
