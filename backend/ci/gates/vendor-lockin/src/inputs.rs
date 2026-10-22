// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{REGISTRY_REL_PATH, TextArtifact};
use std::path::{Path, PathBuf};

pub fn git_root(dir: &Path) -> Result<PathBuf, String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to run git rev-parse: {e}"))?;
    if !out.status.success() {
        return Err("git rev-parse --show-toplevel failed".to_owned());
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&out.stdout).trim().to_owned(),
    ))
}

pub fn git_tracked_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let out = std::process::Command::new("git")
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .current_dir(root)
        .output()
        .map_err(|e| format!("failed to run git ls-files: {e}"))?;
    if !out.status.success() {
        return Err("git ls-files failed".to_owned());
    }
    Ok(String::from_utf8(out.stdout)
        .map_err(|e| format!("git file paths are not UTF-8: {e}"))?
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|line| root.join(line))
        .collect())
}

pub fn collect_artifacts(repo_root: &Path) -> Result<Vec<TextArtifact>, String> {
    let mut artifacts = Vec::new();
    for path in git_tracked_files(repo_root)? {
        let rel = match path.strip_prefix(repo_root) {
            Ok(rel) => rel.to_path_buf(),
            Err(_) => path.clone(),
        };
        if rel == Path::new(REGISTRY_REL_PATH) {
            continue;
        }
        let bytes = std::fs::read(&path)
            .map_err(|e| format!("cannot read repository artifact {}: {e}", path.display()))?;
        if bytes.contains(&0) {
            continue; // Git's binary marker; binary assets are not repository text.
        }
        let contents = String::from_utf8(bytes)
            .map_err(|e| format!("invalid repository text {}: {e}", path.display()))?;
        artifacts.push(TextArtifact {
            path: rel,
            contents,
        });
    }
    if artifacts.is_empty() {
        return Err("no repository text artifacts found".into());
    }
    Ok(artifacts)
}
