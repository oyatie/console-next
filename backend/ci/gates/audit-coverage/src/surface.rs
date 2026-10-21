//! Which files and signatures the gate treats as handler surfaces or
//! transaction-scoped helpers.

use std::path::Path;

pub(crate) fn is_handler_surface(file: &Path) -> bool {
    // `app` covers `backend/app/src/**` composition-root handlers/pollers that
    // talk to Postgres directly (collaboration, workflow studio, HR, …). This is
    // a path-component mechanism, not a one-file allowlist.
    file.components().any(|component| {
        let part = component.as_os_str().to_string_lossy();
        matches!(part.as_ref(), "application" | "rest" | "worker" | "app")
    }) || is_compliance_location_ping_writer_surface(file)
        || is_hr_adapter_surface(file)
}

/// R2 step 0b: the hr, attendance and leave Postgres adapters receive the hr
/// handler bodies (extract-to-facade), so they are scanned like handlers. A
/// method on a transaction wrapper there is still tx-accepting.
fn is_hr_adapter_surface(file: &Path) -> bool {
    ["hr", "attendance", "leave"]
        .iter()
        .any(|ctx| path_contains_components(file, &["crates", ctx, "adapter-postgres", "src"]))
}

/// The real LocationPing writer lives in the compliance Postgres adapter, not in
/// an `application`/`rest`/`worker`/`app` crate. We scan that adapter as a handler
/// surface so the writer is detected as state-changing and must carry the bound
/// audit exemption — closing the gap where the actual writer escaped coverage.
pub(crate) fn is_compliance_location_ping_writer_surface(file: &Path) -> bool {
    path_ends_with_repo_relative(file, "crates/compliance/adapter-postgres/src/lib.rs")
}

pub(crate) fn path_contains_components(path: &Path, needle: &[&str]) -> bool {
    let parts: Vec<String> = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    parts
        .windows(needle.len())
        .any(|window| window.iter().zip(needle.iter()).all(|(a, b)| a == b))
}

pub(crate) fn accepts_transaction(signature: &str) -> bool {
    let compact: String = signature
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    compact.contains("&mutTransaction<") || compact.contains("&mutsqlx::Transaction<")
}

pub(crate) fn path_ends_with_repo_relative(file: &Path, repo_relative: &str) -> bool {
    let expected: Vec<&str> = repo_relative.split('/').filter(|s| !s.is_empty()).collect();
    let actual: Vec<String> = file
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    if expected.len() > actual.len() {
        return false;
    }
    actual[actual.len() - expected.len()..]
        .iter()
        .zip(expected.iter())
        .all(|(actual_part, expected_part)| actual_part == expected_part)
}
