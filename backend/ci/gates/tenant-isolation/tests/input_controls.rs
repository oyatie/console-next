// SPDX-License-Identifier: LicenseRef-Proprietary
use console_gate_tenant_isolation::{ViolationKind, check_migrations_root, check_workspace};
use std::fs;

#[test]
fn an_audit_bind_cannot_make_missing_migrations_green() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("tenant-inputs-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let audit = root.join("crates/platform/db/src");
    fs::create_dir_all(&audit)?;
    fs::write(audit.join("audit_tx.rs"), "set_config('app.current_org'")?;
    assert!(check_workspace(&root).is_err(), "missing migrations passed");
    fs::create_dir_all(root.join("migrations"))?;
    assert!(check_workspace(&root).is_err(), "empty migrations passed");
    let isolated = check_migrations_root(&root);
    assert!(!isolated.passed());
    assert!(
        isolated
            .violations
            .iter()
            .any(|v| v.kind == ViolationKind::ScanError)
    );
    fs::write(root.join("migrations/0001.sql"), "SELECT 1;\n")?;
    assert!(check_workspace(&root)?.passed());
    assert!(check_migrations_root(&root).passed());
    fs::write(
        root.join("migrations/0002.sql"),
        "CREATE TABLE unclassified (id uuid);\n",
    )?;
    assert!(!check_workspace(&root)?.passed());
    fs::remove_dir_all(root)?;
    Ok(())
}
