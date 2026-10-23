// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Nearest ancestor `Cargo.toml` package name and the directory holding it,
/// searching no higher than `root`.
pub(super) fn owning_crate(source: &Path, root: &Path) -> Option<(String, PathBuf)> {
    let mut dir = source.parent();
    while let Some(current) = dir {
        let manifest = current.join("Cargo.toml");
        if manifest.is_file()
            && let Ok(text) = std::fs::read_to_string(&manifest)
            && let Some(name) = package_name(&text)
        {
            return Some((name, current.to_path_buf()));
        }
        if current == root {
            break;
        }
        dir = current.parent();
    }
    None
}

fn package_name(manifest: &str) -> Option<String> {
    let mut in_package = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if in_package
            && let Some(rest) = line.strip_prefix("name")
            && let Some(rest) = rest.trim_start().strip_prefix('=')
        {
            return Some(rest.trim().trim_matches('"').to_owned());
        }
    }
    None
}

/// Which crates in the tree are actually linked into something that ships.
///
/// The two exclusions this replaces were keyed on the crate's NAME —
/// `starts_with("console-gate-")` and `ends_with("-test-support")` — so a crate
/// could opt itself out of the gate by choosing a name. `ci/gates/*` is a
/// workspace member glob, which made a `console-gate-*` crate holding a real
/// `UPDATE` invisible. Both rules are now keyed on something the build already
/// enforces: where the manifest lives, and whether anything depends on the
/// crate outside `[dev-dependencies]`.
#[derive(Debug, Default)]
pub(super) struct CrateTree {
    /// Crate names appearing in a `[dependencies]`, `[build-dependencies]` or
    /// `[target.*.dependencies]` table somewhere in the tree. A crate here is
    /// linked into whatever depends on it.
    pub(super) shipped_dependencies: BTreeSet<String>,
    /// Crate names appearing in a `[dev-dependencies]` table.
    dev_dependencies: BTreeSet<String>,
}

impl CrateTree {
    /// Prefer Cargo-authoritative metadata when `root` is a Cargo project.
    /// Planted synthetic trees (gate tests) have no root manifest — those use
    /// the key-only text scan, which deliberately does **not** resolve
    /// `package =` renames (console-ugg: text-scan rename spellings are retired).
    pub(super) fn read(root: &Path, manifests: &[PathBuf]) -> Result<Self, std::io::Error> {
        match Self::from_cargo_metadata(root) {
            Ok(tree) => Ok(tree),
            Err(meta_err) if root.join("Cargo.toml").is_file() => Err(std::io::Error::other(
                format!("cargo metadata required for writer-ownership crate graph: {meta_err}"),
            )),
            Err(_) => Self::from_manifest_text(manifests),
        }
    }

    pub(super) fn from_cargo_metadata(root: &Path) -> Result<Self, String> {
        let output = std::process::Command::new("cargo")
            .args(["metadata", "--format-version", "1", "--no-deps"])
            .current_dir(root)
            .output()
            .map_err(|e| format!("failed to run `cargo metadata`: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "`cargo metadata` failed:\n{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let meta: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("failed to parse cargo metadata JSON: {e}"))?;
        let packages = meta["packages"]
            .as_array()
            .ok_or("cargo metadata JSON has no `packages` array")?;
        let mut tree = Self::default();
        for package in packages {
            let Some(deps) = package["dependencies"].as_array() else {
                continue;
            };
            for dep in deps {
                let Some(name) = dep["name"].as_str() else {
                    continue;
                };
                let is_dev = dep["kind"].as_str() == Some("dev");
                let set = if is_dev {
                    &mut tree.dev_dependencies
                } else {
                    &mut tree.shipped_dependencies
                };
                // `name` is the resolved package (Cargo's answer to every
                // `package =` / workspace-inherited rename spelling).
                set.insert(name.to_owned());
                // The Cargo.toml key survives too — that is how the crate is
                // referred to in code when renamed.
                if let Some(rename) = dep["rename"].as_str() {
                    set.insert(rename.to_owned());
                }
            }
        }
        Ok(tree)
    }

    fn from_manifest_text(manifests: &[PathBuf]) -> Result<Self, std::io::Error> {
        let mut tree = Self::default();
        for manifest in manifests {
            let text = std::fs::read_to_string(manifest)?;
            let (shipped, dev) = dependency_edges(&text);
            tree.shipped_dependencies.extend(shipped);
            tree.dev_dependencies.extend(dev);
        }
        Ok(tree)
    }

    /// True when this crate cannot reach production. Exactly two rules, both
    /// keyed on something the build already enforces:
    ///
    /// 1. its manifest lives under `ci/gates/` — the workspace's `ci/gates/*`
    ///    member glob, which is also where the CI runner looks for gate
    ///    binaries;
    /// 2. every dependency edge pointing at it in this tree is a
    ///    `[dev-dependencies]` edge, so it is linked into test binaries only.
    ///
    /// Rule 2 requires at least one edge. A crate nothing references at all is
    /// SCANNED, not exempted: "nobody depends on me yet" is how a new writer
    /// would arrive, and it is also the shape of every synthetic tree in
    /// `tests/gate_detects_violation.rs`.
    ///
    /// Neither rule can be bought by renaming. The previous rules —
    /// `starts_with("console-gate-")` and `ends_with("-test-support")` — both
    /// could, and the first made a `console-gate-*` crate holding a real
    /// `UPDATE` invisible even though `ci/gates/*` is a workspace member.
    pub(super) fn is_unshipped(&self, crate_name: &str, manifest_dir: &Path, root: &Path) -> bool {
        is_ci_gate(manifest_dir, root)
            || (self.dev_dependencies.contains(crate_name)
                && !self.shipped_dependencies.contains(crate_name))
    }
}

/// `<root>/…/ci/gates/<crate>` — the workspace's `ci/gates/*` member glob.
fn is_ci_gate(manifest_dir: &Path, root: &Path) -> bool {
    let Ok(relative) = manifest_dir.strip_prefix(root) else {
        return false;
    };
    let parts: Vec<_> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    parts
        .windows(2)
        .any(|pair| pair[0] == "ci" && pair[1] == "gates")
}

/// Key-only dependency edges from one manifest text.
///
/// Used only for planted synthetic trees that are not a Cargo project.
/// Rename resolution (`package =`, workspace-inherited aliases) is **not**
/// done here — [`CrateTree::from_cargo_metadata`] is the total primitive
/// (console-ugg). A `package =` directive line is skipped so it cannot invent
/// a crate named `package`.
///
/// `[workspace.dependencies]` is NOT an edge — it is the workspace's version
/// registry, and every dev-dependency in the tree is also listed there. Reading
/// it as an edge is what would make `console-platform-test-support` look
/// production-linked.
pub(super) fn dependency_edges(manifest: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut shipped = BTreeSet::new();
    let mut dev = BTreeSet::new();
    let mut table: Option<bool> = None; // Some(is_dev)
    for line in manifest.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let header = header.trim_start_matches('[').trim_end_matches(']');
            table = classify_dependency_table(header).map(|(is_dev, named)| {
                if let Some(dependency) = named {
                    // `[dependencies.foo]` names the crate in the header.
                    if is_dev { &mut dev } else { &mut shipped }
                        .insert(dependency.trim_matches('"').to_owned());
                }
                is_dev
            });
            continue;
        }
        let Some(is_dev) = table else { continue };
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // `name = …` and `name.workspace = true` both key on the same prefix.
        let key = line
            .split('=')
            .next()
            .unwrap_or_default()
            .split('.')
            .next()
            .unwrap_or_default()
            .trim();
        // Rename directive — never a dependency named `package`. Real package
        // names come from `cargo metadata`, not another text-scan branch.
        if key == "package" || key.is_empty() {
            continue;
        }
        if is_dev { &mut dev } else { &mut shipped }.insert(key.trim_matches('"').to_owned());
    }
    (shipped, dev)
}

/// `(is_dev, the crate named by the header itself)` for a dependency table, or
/// `None` when the header is not one.
pub(super) fn classify_dependency_table(header: &str) -> Option<(bool, Option<&str>)> {
    if header == "workspace.dependencies" || header.starts_with("workspace.") {
        return None;
    }
    let is_dev_table =
        |name: &str| name == "dev-dependencies" || name.ends_with(".dev-dependencies");
    let is_table = |name: &str| {
        name == "dependencies"
            || name == "build-dependencies"
            || name.ends_with(".dependencies")
            || name.ends_with(".build-dependencies")
            || is_dev_table(name)
    };
    if is_table(header) {
        return Some((is_dev_table(header), None));
    }
    // `[dependencies.foo]` / `[target.'cfg(x)'.dev-dependencies.foo]`
    let (prefix, dependency) = header.rsplit_once('.')?;
    if is_table(prefix) {
        return Some((is_dev_table(prefix), Some(dependency)));
    }
    None
}
