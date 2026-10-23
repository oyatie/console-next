// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_gate_migration_safety::check_migrations_root;

#[test]
fn table_owner_privileges_cannot_be_revoked() {
    let root = std::env::temp_dir().join(format!("migration-owner-{}", std::process::id()));
    let migrations = root.join("migrations");
    std::fs::create_dir_all(&migrations).unwrap();
    let file = migrations.join("0001_owner.sql");
    for sql in [
        "REVOKE INSERT, UPDATE, DELETE ON holds FROM console_rt, console_app;",
        "REVOKE ALL PRIVILEGES ON TABLE public.holds FROM \"console_app\" CASCADE;",
        "REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM console_app;",
        "REVOKE UPDATE(reason) ON holds FROM console_app;",
    ] {
        std::fs::write(&file, sql).unwrap();
        assert!(!check_migrations_root(&root).passed(), "accepted {sql}");
    }
    for sql in [
        "REVOKE INSERT, UPDATE, DELETE ON holds FROM console_rt;",
        "REVOKE ALL ON FUNCTION command(uuid) FROM PUBLIC, console_app;",
        "REVOKE ALL ON SEQUENCE counter FROM console_app;",
        "REVOKE console_rt FROM console_app;",
        "-- REVOKE ALL ON holds FROM console_app;\nSELECT 'REVOKE ALL ON holds FROM console_app';",
    ] {
        std::fs::write(&file, sql).unwrap();
        assert!(check_migrations_root(&root).passed(), "rejected {sql}");
    }
    std::fs::remove_dir_all(root).unwrap();
}
