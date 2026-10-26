// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use std::{fs, path::PathBuf, process::Command};

type Result = std::result::Result<(), Box<dyn std::error::Error>>;
struct Repo(PathBuf);
impl Repo {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("iac-tier-{name}-{}", std::process::id()));
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

use console_gate_iac_tier::{audit, collect_artifacts};

#[test]
fn empty_and_irrelevant_repositories_are_not_green() {
    let repo = Repo::new("empty");
    assert!(collect_artifacts(&repo.0).is_err());
    repo.put("README.md", b"documentation");
    repo.git(&["add", "."]);
    assert!(collect_artifacts(&repo.0).is_err());
}

#[test]
fn untracked_manifests_and_unusual_filenames_cannot_hide_violations() {
    let repo = Repo::new("untracked");
    repo.put("deploy/apps/clean.yaml", b"kind: Deployment\n");
    repo.git(&["add", "."]);
    assert!(audit(&collect_artifacts(&repo.0).unwrap()).passed());
    for name in ["with space.yaml", "with\nnewline.yaml"] {
        let path = format!("deploy/apps/{name}");
        repo.put(&path, b"kind: aws_vpc\n");
        assert!(
            !audit(&collect_artifacts(&repo.0).unwrap()).passed(),
            "untracked input omitted"
        );
        repo.git(&["add", "--", &path]);
        assert!(
            !audit(&collect_artifacts(&repo.0).unwrap()).passed(),
            "quoted path omitted"
        );
        fs::remove_file(repo.0.join(&path)).unwrap();
        repo.git(&["rm", "--cached", "--", &path]);
    }
}

#[test]
fn unreadable_and_non_text_manifests_are_not_silently_skipped() -> Result {
    let repo = Repo::new("unreadable");
    let path = repo.put("deploy/apps/app.yaml", b"kind: Deployment\n");
    repo.git(&["add", "."]);
    fs::remove_file(&path)?;
    assert!(collect_artifacts(&repo.0).is_err());
    for bytes in [b"\xff".as_slice(), b"kind:\0Deployment".as_slice()] {
        fs::write(&path, bytes)?;
        assert!(collect_artifacts(&repo.0).is_err());
    }
    fs::write(&path, b"kind: Deployment\n")?;
    assert!(audit(&collect_artifacts(&repo.0)?).passed());
    Ok(())
}

#[test]
fn an_untracked_opentofu_pod_manifest_is_a_violation() {
    let repo = Repo::new("pod");
    repo.put("deploy/apps/clean.yaml", b"kind: Deployment\n");
    repo.git(&["add", "."]);
    repo.put(
        "deploy/opentofu/pod.tf",
        b"resource \"kubernetes_pod\" \"wrong\" {}\n",
    );
    assert!(!audit(&collect_artifacts(&repo.0).unwrap()).passed());
}

#[test]
fn an_explicit_no_iac_declaration_is_green_only_without_iac_files() {
    let repo = Repo::new("declared");
    repo.put("deploy/IAC-NONE.md", b"IaC lives in console-infra.\n");
    repo.git(&["add", "."]);
    assert!(collect_artifacts(&repo.0).unwrap().is_empty());
    repo.put("deploy/apps/app.yaml", b"kind: Deployment\n");
    repo.git(&["add", "."]);
    assert!(collect_artifacts(&repo.0).is_err());
}

#[test]
fn flux_manifests_are_audited_in_every_platform_directory() {
    let repo = Repo::new("flux");
    let paths = [
        "deploy/base/app/api.yaml",
        "deploy/clusters/exit-test/kustomization.yml",
        "deploy/policies/admission.yaml",
        "deploy/reconcile/kustomizations.yaml",
        "deploy/source/oci.yaml",
    ];
    for path in paths {
        repo.put(path, b"kind: Deployment\n");
    }
    let artifacts = collect_artifacts(&repo.0).unwrap();
    assert_eq!(artifacts.len(), paths.len());
    assert!(audit(&artifacts).passed());
    repo.git(&["add", "."]);
    for path in paths {
        repo.put(path, b"kind: aws_vpc\n");
        let result = audit(&collect_artifacts(&repo.0).unwrap());
        assert_eq!(result.violations.len(), 1, "{path}");
        assert_eq!(result.violations[0].path, PathBuf::from(path));
        repo.put(path, b"kind: Deployment\n");
    }
}

#[test]
fn a_no_iac_declaration_cannot_hide_flux_manifests() {
    let repo = Repo::new("flux-declared");
    repo.put("deploy/IAC-NONE.md", b"IaC lives in console-infra.\n");
    repo.put("deploy/base/app/api.yaml", b"kind: Deployment\n");
    assert!(collect_artifacts(&repo.0).is_err());
}

#[test]
fn platform_tool_configuration_and_schemas_are_not_manifests() {
    let repo = Repo::new("flux-config");
    repo.put("deploy/IAC-NONE.md", b"No IaC.\n");
    for path in [
        "deploy/ci/external-secrets-values.yaml",
        "deploy/schemas/deployment_v1.json",
        "deploy/clusters/template/platform.json",
        "deploy/README.md",
    ] {
        repo.put(path, b"aws_vpc\n");
    }
    assert!(collect_artifacts(&repo.0).unwrap().is_empty());
}
