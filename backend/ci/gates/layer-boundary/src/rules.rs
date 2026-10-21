//! Framework confinement and the named exceptions to the layer rules (ADR-011).
//!
//! Every table here is SHRINK-ONLY: an entry whose edge or dependency no longer
//! exists is itself a violation (`STALE_EXCEPTION`), so deleting the offending
//! Cargo edge forces deleting its entry in the same commit. Adding an entry
//! needs an ADR reference in its reason.

use std::path::{Component, Path, PathBuf};

use crate::{Layer, Metadata, Package, Violation, ViolationKind};

mod named_edges;
pub use named_edges::NAMED_EDGES;

/// A framework crate confined to the listed workspace crates (ADR-001 §frameworks).
pub const CONFINED_DEPS: &[(&str, &[&str])] = &[
    ("cedar-policy", &["console-platform-authz"]),
    ("calamine", &["console-platform-excel"]),
    ("umya-spreadsheet", &["console-platform-excel"]),
];

/// (crate, external dep, reason). Pinned offenders found on 2026-10-02 by
/// running this gate on `console-react-mvp`; each names the step that removes it.
pub const FORBIDDEN_DEP_EXCEPTIONS: &[(&str, &str, &str)] = &[
    // rest += sqlx: SQL in inbound adapters. Each entry is removed when that
    // context's SQL moves behind `<ctx>-adapter-postgres` (Tier 1 for identity,
    // otherwise Tier 2/3 or the BW lane that touches the context).
    (
        "console-analytics-quant-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    ("console-comms-rest", "sqlx", "baseline 2026-10-02 (Tier 3)"),
    (
        "console-consulting-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-dispatch-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    ("console-docs-rest", "sqlx", "baseline 2026-10-02 (Tier 3)"),
    (
        "console-facilities-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-finance-gl-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-financial-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-governance-rest",
        "sqlx",
        "baseline 2026-10-02 (BW-06 lane)",
    ),
    (
        "console-identity-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 1 step 7c moves rollout SQL to the identity adapter)",
    ),
    (
        "console-inspection-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-ontology-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-payroll-rest",
        "sqlx",
        "baseline 2026-10-02 (BW-09 lane)",
    ),
    (
        "console-production-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-reporting-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-support-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-workorder-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-platform-auth-rest",
        "sqlx",
        "baseline 2026-10-02 (Phase 3 session-store split)",
    ),
    (
        "console-platform-authz-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    (
        "console-platform-rest",
        "sqlx",
        "baseline 2026-10-02 (Tier 3)",
    ),
    // adapter += axum
    (
        "console-integrity",
        "axum",
        "baseline 2026-10-02: generic crate classified Adapter by fallback (Tier 3)",
    ),
    // calamine outside platform/excel
    (
        "console-app",
        "calamine",
        "baseline 2026-10-02 (Tier 1 step 4 moves the hr upload reader to platform/excel)",
    ),
    (
        "console-registry-adapter-postgres",
        "calamine",
        "baseline 2026-10-02 (Tier 3)",
    ),
];

/// `#[path = "…"]` attributes allowed to leave their crate (crate, path suffix, reason).
pub const PATH_ESCAPE_EXCEPTIONS: &[(&str, &str, &str)] = &[(
    "console-orgchange-adapter-postgres",
    "ontology/canonical-adapter-postgres/src/org_unit_binding.rs",
    "compiles the canonical owner's DML into orgchange; replaced by a NAMED_EDGES owner entry in the orgchange split (ADR-004)",
)];

/// External crates a layer may not depend on (normal dependencies only).
pub fn layer_forbids(layer: &Layer) -> &'static [&'static str] {
    const PURE: &[&str] = &[
        "sqlx",
        "axum",
        "tokio",
        "http",
        "reqwest",
        "cedar-policy",
        "calamine",
        "umya-spreadsheet",
        "utoipa",
        "lettre",
        "apalis",
    ];
    match layer {
        Layer::Domain | Layer::Application => PURE,
        Layer::Rest => &["sqlx"],
        Layer::Adapter => &["axum"],
        Layer::Ui => &["sqlx"],
        _ => &[],
    }
}

/// `crates/platform/*-rest` crates are classified Platform (the path check runs
/// before the suffix check), but they are inbound HTTP adapters: they get the
/// Rest purity rule by name without changing their workspace-edge privileges.
fn platform_rest(krate: &str) -> bool {
    krate.starts_with("console-platform-") && krate.ends_with("-rest")
}

fn excepted(krate: &str, dep: &str) -> bool {
    FORBIDDEN_DEP_EXCEPTIONS
        .iter()
        .any(|(c, d, _)| *c == krate && *d == dep)
}

/// True when `krate` (in `layer`) may not take the external dependency `dep`.
pub fn forbidden_external(layer: &Layer, krate: &str, dep: &str) -> bool {
    if *layer == Layer::Gate || excepted(krate, dep) {
        return false;
    }
    let confined = CONFINED_DEPS
        .iter()
        .any(|(d, owners)| *d == dep && !owners.contains(&krate));
    let rest_purity = platform_rest(krate) && layer_forbids(&Layer::Rest).contains(&dep);
    confined || rest_purity || layer_forbids(layer).contains(&dep)
}

/// True when a workspace edge the layer table forbids is listed in `NAMED_EDGES`.
pub fn named_edge(krate: &str, dep: &str) -> bool {
    NAMED_EDGES
        .iter()
        .any(|(from, to, _)| *from == krate && *to == dep)
}

fn normal_dep(pkg: &Package, dep: &str) -> bool {
    pkg.dependencies
        .iter()
        .any(|d| d.name == dep && d.kind.is_none())
}

/// Entries whose crate or edge no longer exists. Keeps the tables shrink-only.
/// Called from `main` on the real workspace only (unit fixtures lack these crates).
pub fn stale_entries(metadata: &Metadata) -> Vec<Violation> {
    let pkgs: Vec<&Package> = metadata
        .packages
        .iter()
        .filter(|p| metadata.workspace_members.contains(&p.id))
        .collect();
    let find = |name: &str| pkgs.iter().find(|p| p.name == name);
    let mut out = Vec::new();
    let mut stale = |krate: &str, detail: String| {
        out.push(Violation {
            kind: ViolationKind::StaleException,
            crate_name: krate.to_owned(),
            detail,
        });
    };
    for (from, to, _) in NAMED_EDGES {
        if !find(from).is_some_and(|p| normal_dep(p, to)) {
            stale(
                from,
                format!(
                    "NAMED_EDGES lists {from} → {to}, which no longer exists; delete the entry"
                ),
            );
        }
    }
    for (krate, dep, _) in FORBIDDEN_DEP_EXCEPTIONS {
        if !find(krate).is_some_and(|p| normal_dep(p, dep)) {
            stale(
                krate,
                format!(
                    "FORBIDDEN_DEP_EXCEPTIONS lists {krate} → {dep}, which no longer exists; delete the entry"
                ),
            );
        }
    }
    out
}

/// Lexically normalises `a/b/../c` → `a/c` (no filesystem access).
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|n| n != "target") {
                rust_files(&path, out)?;
            }
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    Ok(())
}

/// `#[path = "…"]` in `src/` that resolves outside the declaring crate compiles
/// another crate's source into production code — an edge Cargo (and this gate)
/// cannot see. `tests/` sharing fixtures through `#[path]` is not scanned.
/// Unreadable crates fail closed (`Err`).
pub fn check_path_escapes(metadata: &Metadata) -> Result<Vec<Violation>, String> {
    let mut violations = Vec::new();
    for pkg in metadata
        .packages
        .iter()
        .filter(|p| metadata.workspace_members.contains(&p.id))
    {
        let Some(root) = Path::new(&pkg.manifest_path).parent() else {
            continue;
        };
        let src = root.join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files).map_err(|e| format!("{}: {e}", src.display()))?;
        for file in files {
            let text =
                std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
            for (idx, line) in text.lines().enumerate() {
                let Some(rest) = line.trim().strip_prefix("#[path") else {
                    continue;
                };
                let Some(target) = rest.split('"').nth(1) else {
                    continue;
                };
                let resolved = normalise(&file.parent().unwrap_or(root).join(target));
                let allowed = PATH_ESCAPE_EXCEPTIONS
                    .iter()
                    .any(|(c, suffix, _)| *c == pkg.name && resolved.ends_with(suffix));
                if !resolved.starts_with(root) && !allowed {
                    violations.push(Violation {
                        kind: ViolationKind::PathEscape,
                        crate_name: pkg.name.clone(),
                        detail: format!(
                            "{}:{}: #[path] leaves the crate ({target})",
                            file.display(),
                            idx + 1
                        ),
                    });
                }
            }
        }
    }
    Ok(violations)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cedar_is_confined_to_platform_authz() {
        assert!(forbidden_external(
            &Layer::Platform,
            "console-platform-db",
            "cedar-policy"
        ));
        assert!(!forbidden_external(
            &Layer::Platform,
            "console-platform-authz",
            "cedar-policy"
        ));
        assert!(forbidden_external(
            &Layer::App,
            "console-app",
            "cedar-policy"
        ));
    }

    #[test]
    fn rest_may_not_take_sqlx_and_adapter_may_not_take_axum() {
        assert!(forbidden_external(&Layer::Rest, "console-hr-rest", "sqlx"));
        assert!(forbidden_external(
            &Layer::Adapter,
            "console-hr-adapter-postgres",
            "axum"
        ));
        assert!(!forbidden_external(
            &Layer::Adapter,
            "console-hr-adapter-postgres",
            "http"
        ));
        assert!(forbidden_external(
            &Layer::Domain,
            "console-hr-domain",
            "http"
        ));
    }

    #[test]
    fn edges_need_a_named_entry() {
        assert!(!named_edge(
            "console-x-adapter-postgres",
            "console-y-adapter-postgres"
        ));
        assert!(named_edge(
            "console-platform-realtime",
            "console-messenger-adapter-postgres"
        ));
    }

    #[test]
    fn platform_rest_crates_get_rest_purity() {
        assert!(forbidden_external(
            &Layer::Platform,
            "console-platform-new-rest",
            "sqlx"
        ));
        assert!(!forbidden_external(
            &Layer::Platform,
            "console-platform-db",
            "sqlx"
        ));
    }

    #[test]
    fn normalise_resolves_parent_segments() {
        assert_eq!(
            normalise(Path::new("/w/crates/a/src/../../b/src/x.rs")),
            PathBuf::from("/w/crates/b/src/x.rs")
        );
    }
}
