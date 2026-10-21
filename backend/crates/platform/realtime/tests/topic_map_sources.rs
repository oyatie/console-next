//! Every `realtime_topic_map` row names an audit action some writer in the
//! tree actually emits, so a typo in the map is a test failure instead of a
//! screen that silently never updates.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};

fn backend() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn walk(dir: &Path, out: &mut String) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy();
        if path.is_dir() {
            if !matches!(name.as_ref(), "target" | "tests" | "migrations" | ".git") {
                walk(&path, out);
            }
        } else if name.ends_with(".rs") || name.ends_with(".sql") {
            out.push_str(&fs::read_to_string(&path).unwrap());
        }
    }
}

#[test]
fn every_mapped_action_is_written_somewhere() {
    let migrations = backend().join("crates/platform/db/migrations");
    let map = fs::read_dir(&migrations)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.to_string_lossy().ends_with("_realtime_changes.sql"))
        .expect("the RT-0 migration");
    let map = fs::read_to_string(map).unwrap();
    let rows: Vec<&str> = map
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("('") && line.contains("', '"))
        .collect();
    assert!(rows.len() >= 80, "{} rows", rows.len());

    let mut source = String::new();
    // `crates` includes the schema baseline, which holds the SQL-function
    // writers (data_import.apply).
    for root in ["app/src", "crates"] {
        walk(&backend().join(root), &mut source);
    }
    for row in rows {
        let action = row.split("', '").nth(1).unwrap();
        assert!(
            source.contains(&format!("\"{action}\"")) || source.contains(&format!("'{action}'")),
            "no writer emits {action}"
        );
    }
}
