//! Runtime walk of the router source directories (PREREG-1, concurrency C4).
//!
//! The `include_str!` lists in the parent need one line per file, and a lane
//! module that does not exist yet cannot be listed at all. This walk reads
//! every `.rs` file under `app/src/**` and `crates/**/rest/src/**` at test
//! time, so a new module is censused and route-checked without editing this
//! test. Files already embedded above keep their existing, stricter checks.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::{
    APP_PRODUCTION_SOURCES, CONFIGURED_ROUTE_SOURCES, CONFIGURED_ROUTE_SURFACES,
    EXTRA_REST_SOURCES, PAYROLL_REST_INNER_SOURCES, normalize_path_parameters, route_calls,
    route_path_constants, strip_cfg_test,
};

// E2E-only routes are mounted only in dev and the test-support binary.
const TEST_SUPPORT_ROUTER_SOURCES: &[&str] = &["app/src/routes/e2e_fixtures.rs"];

pub(super) struct WalkedSource {
    /// Path relative to `backend/`.
    pub(super) name: &'static str,
    pub(super) source: &'static str,
    crate_source: &'static str,
    /// Included in a source the parent already checks, possibly with its constants.
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

    let mut crate_sources = BTreeMap::new();
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
            let lib = path
                .ancestors()
                .find(|dir| dir.file_name().is_some_and(|name| name == "src"))
                .expect("router source is under src")
                .join("lib.rs");
            let crate_source = *crate_sources.entry(lib.clone()).or_insert_with(|| {
                let text = fs::read_to_string(&lib)
                    .unwrap_or_else(|error| panic!("read {}: {error}", lib.display()));
                &*Box::leak(text.into_boxed_str())
            });
            WalkedSource {
                embedded: embedded.iter().any(|source| source.contains(text.as_str())),
                name: Box::leak(name.into_boxed_str()),
                source: Box::leak(text.into_boxed_str()),
                crate_source,
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
    for known in [
        "app/src/lib.rs",
        "crates/identity/rest/src/lib.rs",
        "app/src/hr/lane_routes.rs",
        "crates/registry/rest/src/routes.rs",
    ] {
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
    assert_routes_in_configured_surfaces(walked_router_sources());
}

#[test]
#[should_panic(
    expected = "unresolvable fixture has unresolved route argument crate::UNRESOLVED_PATH"
)]
fn unresolvable_route_path_is_rejected() {
    assert_routes_in_configured_surfaces([WalkedSource {
        name: "unresolvable fixture",
        source: r#"
            #[test]
            fn fixture() { Router::new().route("/test-only", get(handler)); }
            fn router() { Router::new().route(crate::UNRESOLVED_PATH, get(handler)); }
        "#,
        embedded: false,
        crate_source: "",
    }]);
}

#[test]
fn test_functions_do_not_contribute_production_routes() {
    assert_routes_in_configured_surfaces([WalkedSource {
        name: "test function fixture",
        source: r#"
            #[tokio::test]
            async fn async_fixture() { Router::new().route("/test-only", get(handler)); }
            #[test]
            fn sync_fixture() { Router::new().route("/also-test-only", get(handler)); }
            fn router() { Router::new().route("/api/platform/users/me", get(handler)); }
        "#,
        embedded: false,
        crate_source: "",
    }]);
}

#[test]
fn crate_root_route_constants_are_resolved() {
    let payroll = walked_router_sources()
        .into_iter()
        .find(|source| source.name == "crates/payroll/rest/src/pay_groups.rs")
        .expect("payroll router source");
    assert!(!payroll.embedded);
    assert!(payroll.source.contains(".route(crate::PAYROLL_RUNS_PATH,"));
    assert_routes_in_configured_surfaces([payroll]);
}

#[test]
fn commented_test_attributes_do_not_hide_routes() {
    for comment in ["// #[test]", "/* outer /* #[tokio::test] */ #[test] */"] {
        let source = format!(
            "{comment}\nfn router() {{ Router::new().route(\"/missing-from-inventory\", get(handler)); }}"
        );
        let failure = std::panic::catch_unwind(|| {
            assert_routes_in_configured_surfaces([WalkedSource {
                name: "comment fixture",
                source: Box::leak(source.into_boxed_str()),
                embedded: false,
                crate_source: "",
            }]);
        })
        .expect_err("comment must not hide the production route");
        let message = failure.downcast_ref::<String>().expect("route diagnostic");
        assert!(message.contains("comment fixture route /missing-from-inventory"));
    }
}

#[test]
fn commented_routes_do_not_contribute_production_routes() {
    assert_routes_in_configured_surfaces([WalkedSource {
        name: "commented route fixture",
        source: r##"
            // .route(crate::COMMENTED_PATH, get(handler))
            /* outer /* .route(crate::COMMENTED_PATH, get(handler)) */ */
            const URL: &str = "https://example.com/";
            const RAW: &str = r#"a quote " /* still a string */"#;
            const QUOTE: char = '"';
            fn router() { Router::new().route("/api/platform/users/me", get(handler)); }
        "##,
        embedded: false,
        crate_source: "",
    }]);
}

fn assert_routes_in_configured_surfaces(sources: impl IntoIterator<Item = WalkedSource>) {
    let inventory: BTreeSet<String> = CONFIGURED_ROUTE_SURFACES
        .iter()
        .flat_map(|surface| surface.paths.iter())
        .map(|path| normalize_path_parameters(path))
        .collect();
    let mut problems = Vec::new();
    for walked in sources.into_iter().filter(|walked| !walked.embedded) {
        let source = strip_comments(walked.source)
            .replace("#[tokio::test]", "#[cfg(test)]")
            .replace("#[test]", "#[cfg(test)]");
        let stripped: &'static str = Box::leak(strip_cfg_test(&source).into_boxed_str());
        let constants = route_path_constants(&strip_cfg_test(&strip_comments(walked.crate_source)));
        for route in route_calls(stripped, &[]) {
            let path = route.path.or_else(|| {
                route
                    .argument
                    .strip_prefix("crate::")
                    .and_then(|name| constants.get(name))
                    .cloned()
            });
            match path {
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

fn strip_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"'\"'") {
            i += 3;
        } else if bytes[i] == b'"' {
            let hashes = bytes[..i].iter().rev().take_while(|&&b| b == b'#').count();
            let raw = i > hashes && bytes[i - hashes - 1] == b'r';
            let suffix = &bytes[i - hashes..i];
            i += 1;
            while i < bytes.len() {
                if !raw && bytes[i] == b'\\' {
                    i = (i + 2).min(bytes.len());
                } else if bytes[i] == b'"' && (!raw || bytes[i + 1..].starts_with(suffix)) {
                    i += 1 + if raw { hashes } else { 0 };
                    break;
                } else {
                    i += 1;
                }
            }
        } else if bytes[i..].starts_with(b"//") || bytes[i..].starts_with(b"/*") {
            let start = i;
            let block = bytes[i + 1] == b'*';
            i += 2;
            let mut depth = 1;
            while i < bytes.len() {
                if !block && bytes[i] == b'\n' {
                    break;
                } else if block && bytes[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if block && bytes[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            for byte in &mut out[start..i] {
                if *byte != b'\n' {
                    *byte = b' ';
                }
            }
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).expect("comment removal preserves UTF-8")
}
