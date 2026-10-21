// SPDX-License-Identifier: LicenseRef-Proprietary
use console_gate_file_size::{ROOTS, measure};
use std::{fs, path::PathBuf};

#[test]
fn missing_empty_and_partial_source_roots_are_not_green() -> std::io::Result<()> {
    let root = std::env::temp_dir().join(format!("file-size-inputs-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root)?;
    assert!(measure(&root.join("missing")).is_err());
    assert!(measure(&root).is_err(), "empty scan passed");
    for dir in ROOTS {
        fs::create_dir_all(root.join(dir))?;
    }
    assert!(measure(&root).is_err(), "empty source roots passed");
    fs::write(root.join("app/main.rs"), "fn main() {}\n")?;
    assert_eq!(measure(&root)?.len(), 1);
    fs::remove_dir(root.join("crates"))?;
    assert!(measure(&root).is_err(), "partly missing source tree passed");
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn a_file_in_place_of_a_source_directory_is_not_green() -> std::io::Result<()> {
    let root: PathBuf =
        std::env::temp_dir().join(format!("file-size-not-dir-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root)?;
    for dir in ROOTS {
        fs::create_dir_all(root.join(dir))?;
    }
    fs::write(root.join("app/main.rs"), "fn main() {}\n")?;
    fs::remove_dir(root.join("crates"))?;
    fs::write(root.join("crates"), "not a directory")?;
    assert!(measure(&root).is_err());
    fs::remove_dir_all(root)?;
    Ok(())
}
