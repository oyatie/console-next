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

/// Paths that `.gitattributes` declares binary (`binary` or `-text`): an explicit declaration, never a guess.
pub fn git_declared_binary(
    root: &Path,
    files: &[PathBuf],
) -> Result<std::collections::HashSet<PathBuf>, String> {
    use std::io::Write;
    let mut child = std::process::Command::new("git")
        .args(["check-attr", "-z", "--stdin", "binary"])
        .current_dir(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run git check-attr: {e}"))?;
    let mut input = Vec::new();
    for path in files {
        input.extend_from_slice(
            path.strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .as_bytes(),
        );
        input.push(0);
    }
    // Write from a thread: on a real repository git's stdout fills the pipe before stdin is drained (deadlock).
    let mut stdin = child.stdin.take().ok_or("git check-attr: no stdin")?;
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let out = child
        .wait_with_output()
        .map_err(|e| format!("git check-attr: {e}"))?;
    writer
        .join()
        .map_err(|_| "git check-attr: writer panicked".to_owned())?
        .map_err(|e| format!("git check-attr: {e}"))?;
    if !out.status.success() {
        return Err("git check-attr failed".to_owned());
    }
    let fields: Vec<&[u8]> = out.stdout.split(|b| *b == 0).collect();
    Ok(fields
        .chunks(3)
        .filter(|c| c.len() == 3 && c[2] == b"set")
        .map(|c| root.join(String::from_utf8_lossy(c[0]).as_ref()))
        .collect())
}

pub fn collect_artifacts(repo_root: &Path) -> Result<Vec<TextArtifact>, String> {
    let mut artifacts = Vec::new();
    let files = git_tracked_files(repo_root)?;
    let declared_binary = git_declared_binary(repo_root, &files)?;
    for path in files {
        if declared_binary.contains(&path) {
            continue; // declared binary in .gitattributes (e.g. fuzz corpora): not repository text
        }
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
