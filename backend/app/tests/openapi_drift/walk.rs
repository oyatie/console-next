//! Runtime walk of the router source directories (PREREG-1, concurrency C4).
//!
//! The `include_str!` lists in the parent need one line per file, and a lane
//! module that does not exist yet cannot be listed at all. This walk reads
//! every `.rs` file under `app/src/**` and `crates/**/rest/src/**` at test
//! time, so a new module is censused and route-checked without editing this
//! test. Files already embedded above keep their existing, stricter checks.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::{
    APP_PRODUCTION_SOURCES, CONFIGURED_ROUTE_SOURCES, CONFIGURED_ROUTE_SURFACES,
    EXTRA_REST_SOURCES, PAYROLL_REST_INNER_SOURCES, normalize_path_parameters, route_calls,
    strip_cfg_test,
};

// E2E-only routes are mounted only in dev and the test-support binary.
const TEST_SUPPORT_ROUTER_SOURCES: &[&str] = &["app/src/routes/e2e_fixtures.rs"];

pub(super) struct WalkedSource {
    /// Path relative to `backend/`.
    pub(super) name: &'static str,
    pub(super) source: &'static str,
    /// Byte-identical to a source the parent already embeds.
    pub(super) embedded: bool,
}

pub(super) fn walked_router_sources() -> Vec<WalkedSource> {
    let backend = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    collect_rs(&backend.join("app/src"), &mut files);
    let mut crate_files = Vec::new();
    collect_rs(&backend.join("crates"), &mut crate_files);
    files.extend(crate_files.into_iter().filter(|path| under_rest_src(path)));
    files.sort();

    let embedded: Vec<&str> = CONFIGURED_ROUTE_SOURCES
        .iter()
        .map(|source| source.source)
        .chain(
            APP_PRODUCTION_SOURCES
                .iter()
                .chain(EXTRA_REST_SOURCES)
                .chain(PAYROLL_REST_INNER_SOURCES)
                .map(|(_, source)| *source),
        )
        .collect();

    files
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            let name = path
                .strip_prefix(&backend)
                .unwrap_or(&path)
                .display()
                .to_string();
            WalkedSource {
                embedded: embedded.contains(&text.as_str()),
                name: Box::leak(name.into_boxed_str()),
                source: Box::leak(text.into_boxed_str()),
            }
        })
        .filter(|source| !TEST_SUPPORT_ROUTER_SOURCES.contains(&source.name))
        .collect()
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !path.ends_with("target") {
                collect_rs(&path, out);
            }
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn under_rest_src(path: &Path) -> bool {
    let parts: Vec<_> = path
        .components()
        .filter_map(|part| match part {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    parts.windows(2).any(|pair| pair == ["rest", "src"])
}

#[test]
fn router_source_walk_recognizes_the_embedded_sources() {
    let walked = walked_router_sources();
    for known in ["app/src/lib.rs", "crates/identity/rest/src/lib.rs"] {
        let found = walked
            .iter()
            .find(|source| source.name.ends_with(known))
            .unwrap_or_else(|| panic!("router source walk did not reach {known}"));
        assert!(found.embedded, "{known} must match its include_str! copy");
    }
    assert!(
        walked.iter().filter(|source| source.embedded).count() >= 20,
        "router source walk recognized too few embedded sources; is the walk root wrong?"
    );
}

#[test]
fn unembedded_router_routes_are_in_a_configured_surface() {
    let inventory: BTreeSet<String> = CONFIGURED_ROUTE_SURFACES
        .iter()
        .flat_map(|surface| surface.paths.iter())
        .map(|path| normalize_path_parameters(path))
        .collect();
    let mut problems = Vec::new();
    for walked in walked_router_sources()
        .into_iter()
        .filter(|walked| !walked.embedded)
    {
        let stripped: &'static str = Box::leak(strip_cfg_test(walked.source).into_boxed_str());
        for route in route_calls(stripped, &[]) {
            match route.path {
                None => problems.push(format!(
                    "{} has unresolved route argument {}",
                    walked.name, route.argument
                )),
                Some(path) if !inventory.contains(&normalize_path_parameters(&path)) => problems
                    .push(format!(
                        "{} route {path} is in no CONFIGURED_ROUTE_SURFACES entry",
                        walked.name
                    )),
                Some(_) => {}
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
