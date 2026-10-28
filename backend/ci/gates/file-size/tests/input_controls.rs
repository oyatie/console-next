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

#[test]
fn a_planted_cfg_test_attribute_cannot_hide_integration_test_code() -> std::io::Result<()> {
    let root = std::env::temp_dir().join(format!("file-size-integration-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    for dir in ROOTS {
        fs::create_dir_all(root.join(dir))?;
    }
    let source = "#[test]\nfn probe() {\n    assert!(true);\n}\n";
    for dir in ["app/tests", "crates/example/tests/nested", "ci/tests"] {
        fs::create_dir_all(root.join(dir))?;
        let relative = format!("{dir}/probe.rs");
        let file = root.join(&relative);
        fs::write(&file, source)?;
        let before = measure(&root)?[&relative];
        fs::write(&file, format!("#[cfg(test)]\n{source}"))?;
        assert_eq!(measure(&root)?[&relative], before + 1, "{relative}");
    }
    fs::create_dir_all(root.join("app/src"))?;
    fs::write(
        root.join("app/src/lib.rs"),
        format!("#[cfg(test)]\n{source}"),
    )?;
    assert_eq!(measure(&root)?["app/src/lib.rs"], 0);
    fs::remove_dir_all(root)?;
    Ok(())
}
