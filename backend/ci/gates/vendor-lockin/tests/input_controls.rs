// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::{fs, path::PathBuf, process::Command};

type Result = std::result::Result<(), Box<dyn std::error::Error>>;
struct Repo(PathBuf);
impl Repo {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("vendor-lockin-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let repo = Self(root);
        repo.git(&["init", "-q"]);
        repo
    }
    fn git(&self, args: &[&str]) {
        let mut cmd = Command::new("git");
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("GIT_") {
                cmd.env_remove(name);
            }
        }
        let out = cmd.args(args).current_dir(&self.0).output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn put(&self, file: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

use console_gate_vendor_lockin::{Registry, audit, collect_artifacts};

fn empty_registry() -> Registry {
    Registry {
        schema_version: 1,
        entry_type: "managed_cloud_dependency_phaseout".into(),
        entries: vec![],
    }
}

#[test]
fn empty_repository_and_binary_only_inputs_are_not_green() {
    let repo = Repo::new("empty");
    assert!(collect_artifacts(&repo.0).is_err());
    repo.put("image.bin", b"image\0bytes");
    repo.git(&["add", "."]);
    assert!(collect_artifacts(&repo.0).is_err());
}

#[test]
fn untracked_seams_and_unusual_filenames_cannot_hide_violations() {
    let repo = Repo::new("untracked");
    repo.put("main.rs", b"fn main() {}\n");
    repo.git(&["add", "."]);
    assert!(audit(&collect_artifacts(&repo.0).unwrap(), &empty_registry()).passed());
    for name in ["with space.tf", "with\nnewline.tf"] {
        repo.put(name, b"OCI Vault");
        assert!(!audit(&collect_artifacts(&repo.0).unwrap(), &empty_registry()).passed());
        repo.git(&["add", "--", name]);
        assert!(!audit(&collect_artifacts(&repo.0).unwrap(), &empty_registry()).passed());
        fs::remove_file(repo.0.join(name)).unwrap();
        repo.git(&["rm", "--cached", "--", name]);
    }
}

#[test]
fn missing_and_invalid_utf8_text_is_not_silently_skipped() -> Result {
    let repo = Repo::new("unreadable");
    let path = repo.put("main.rs", b"fn main() {}\n");
    repo.git(&["add", "."]);
    fs::remove_file(&path)?;
    assert!(collect_artifacts(&repo.0).is_err());
    fs::write(&path, b"\xff")?;
    assert!(collect_artifacts(&repo.0).is_err());
    fs::write(&path, b"fn main() {}\n")?;
    repo.put("image.bin", b"image\0bytes");
    repo.git(&["add", "."]);
    assert_eq!(collect_artifacts(&repo.0)?.len(), 1);
    Ok(())
}
