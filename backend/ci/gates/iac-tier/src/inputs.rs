// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{IacArtifact, IacTier};
use std::path::{Path, PathBuf};

/// Resolve the git repository root containing `dir` (works from any subdir).
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

/// Lists tracked and untracked, non-ignored working files as absolute paths.
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
        .map(|l| root.join(l))
        .collect())
}

/// Walk the working files under `repo_root` and classify the ones that
/// live in a known IaC tier directory into `IacArtifact`s. Everything else
/// (docs, examples, `.gitignore`, non-manifest files) is skipped.
pub fn collect_artifacts(repo_root: &Path) -> Result<Vec<IacArtifact>, String> {
    let mut artifacts = Vec::new();
    for path in git_tracked_files(repo_root)? {
        let rel = path.strip_prefix(repo_root).unwrap_or(path.as_path());
        let rel_str = rel.to_string_lossy();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

        let tier = if (rel_str.starts_with("deploy/argocd/") || rel_str.starts_with("deploy/apps/"))
            && matches!(ext, "yaml" | "yml")
        {
            Some(IacTier::TierAArgoCd)
        } else if rel_str.starts_with("deploy/opentofu/") && matches!(ext, "tf" | "tofu") {
            Some(IacTier::TierBOpenTofu)
        } else {
            None
        };

        let Some(tier) = tier else { continue };
        let contents = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read IaC artifact {}: {e}", path.display()))?;
        if contents.contains('\0') {
            return Err(format!(
                "IaC artifact {} contains binary data",
                path.display()
            ));
        }
        artifacts.push(IacArtifact {
            tier,
            path: rel.to_path_buf(),
            contents,
        });
    }
    if artifacts.is_empty() {
        return Err(
            "no IaC artifacts found in deploy/argocd, deploy/apps or deploy/opentofu".into(),
        );
    }
    Ok(artifacts)
}
