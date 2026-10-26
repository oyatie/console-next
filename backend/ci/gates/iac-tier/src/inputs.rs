// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{IacArtifact, IacTier};
use std::path::{Path, PathBuf};

/// An explicit, reviewed statement that this repository holds no IaC (and where it lives instead).
pub const NO_IAC_DECLARATION: &str = "deploy/IAC-NONE.md";

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

        let tier = if [
            "deploy/argocd/",
            "deploy/apps/",
            "deploy/base/",
            "deploy/clusters/",
            "deploy/policies/",
            "deploy/reconcile/",
            "deploy/source/",
        ]
        .iter()
        .any(|prefix| rel_str.starts_with(prefix))
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
    let declared_none = repo_root.join(NO_IAC_DECLARATION).is_file();
    match (artifacts.is_empty(), declared_none) {
        (true, false) => Err(format!(
            "no IaC artifacts found in the deploy/ manifest or OpenTofu directories, and no {NO_IAC_DECLARATION} declaring where IaC lives"
        )),
        (false, true) => Err(format!(
            "{NO_IAC_DECLARATION} declares no IaC here, but {} IaC artifact(s) exist: remove one or the other",
            artifacts.len()
        )),
        _ => Ok(artifacts),
    }
}
