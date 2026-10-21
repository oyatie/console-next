use console_gate_migration_safety::{ViolationKind, check_workspace};
use std::fs;

#[test]
fn mixed_versions_allow_late_timestamps_but_refuse_duplicates_gaps_and_bad_names()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("timestamp-gate-{}", std::process::id()));
    let migrations = root.join("migrations");
    fs::create_dir_all(&migrations)?;
    for name in [
        "0001_a.sql",
        "0002_b.sql",
        "20261012120000_second.sql",
        "20261012110000_first.sql",
    ] {
        fs::write(migrations.join(name), "SELECT 1;")?;
    }
    assert!(check_workspace(&root)?.passed());
    fs::write(migrations.join("20261012110000_duplicate.sql"), "SELECT 2;")?;
    assert!(
        check_workspace(&root)?
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::DuplicateMigrationVersion)
    );
    fs::remove_file(migrations.join("20261012110000_duplicate.sql"))?;
    fs::remove_file(migrations.join("0001_a.sql"))?;
    assert!(
        check_workspace(&root)?
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::NonContiguousMigrationVersion)
    );
    fs::write(migrations.join("bad_name.sql"), "SELECT 1;")?;
    assert!(
        check_workspace(&root)?
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::InvalidMigrationVersion)
    );
    fs::remove_dir_all(root)?;
    Ok(())
}
