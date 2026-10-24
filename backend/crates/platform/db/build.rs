// SPDX-License-Identifier: LicenseRef-Proprietary
use std::hash::{DefaultHasher, Hash, Hasher};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=../db/migrations");
    println!("cargo:rerun-if-changed=../db/baseline");
    let mut migrations = Vec::new();
    for entry in std::fs::read_dir("../db/migrations")? {
        let path = entry?.path();
        if path.extension().is_some_and(|extension| extension == "sql") {
            migrations.push(path);
        }
    }
    migrations.sort();
    assert!(!migrations.is_empty(), "migration sources must be present");
    let mut fingerprint = DefaultHasher::new();
    for path in migrations {
        path.file_name().hash(&mut fingerprint);
        std::fs::read(path)?.hash(&mut fingerprint);
    }
    // Proc-macro file reads must participate in sccache's compiler-command key.
    println!("cargo:rustc-check-cfg=cfg(console_migrations, values(any()))");
    println!(
        "cargo:rustc-cfg=console_migrations=\"{:016x}\"",
        fingerprint.finish()
    );
    Ok(())
}
