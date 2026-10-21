//! BG-6: at a blue/green promotion worker-<new> and worker-<old> run together
//! for up to ~25 s, and the api may run several replicas. Every periodic loop
//! must therefore be safe with two copies running: it claims per row/org
//! (SKIP LOCKED, a unique idempotency key, an advisory lock, a lease), or
//! holds only process-local state. This census fails when a loop appears that
//! is not listed here with its mechanism, or a listed one is gone.
//! finds `tokio::time::interval(` loops only; a `loop { sleep }`
//! poller would slip by. Widen the needle if one ever lands.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

/// Path (from `backend/`) -> why two copies at once are safe.
const LOOPS: &[(&str, &str)] = &[
    (
        "app/src/lifecycle_schedule.rs",
        "each due event FOR UPDATE SKIP LOCKED, re-checked SCHEDULED",
    ),
    (
        "app/src/workflow_schedules.rs",
        "UNIQUE(org_id, idempotency_key) per fire; guarded advance",
    ),
    (
        "app/src/workflow_drain.rs",
        "idempotent per (outbox event, recipient) staging rows",
    ),
    (
        "app/src/facilities_schedule.rs",
        "obligations FOR UPDATE SKIP LOCKED; cases ON CONFLICT DO NOTHING",
    ),
    (
        "app/src/mail_sync.rs",
        "per-account claim lease (migration 0116)",
    ),
    (
        "crates/platform/audit-chain/src/lib.rs",
        "per-org pg_advisory_xact_lock",
    ),
    (
        "crates/platform/egress-fence/src/lib.rs",
        "process-local fence state, no shared writes",
    ),
];

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if path.is_dir() {
            if !matches!(name.as_str(), "tests" | "target" | "fuzz") && !name.starts_with('.') {
                walk(&path, out);
            }
        } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "tests.rs" {
            out.push(path);
        }
    }
}

#[test]
fn every_periodic_loop_is_replica_safe_and_listed() {
    let backend = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    walk(&backend.join("app/src"), &mut files);
    walk(&backend.join("crates"), &mut files);
    let mut found: Vec<String> = files
        .iter()
        .filter(|path| {
            let text = std::fs::read_to_string(path).unwrap();
            // Production code only: an inline `#[cfg(test)] mod` sits at the end.
            let prod = text.split("#[cfg(test)]").next().unwrap_or_default();
            prod.contains("tokio::time::interval(")
        })
        .map(|path| path.strip_prefix(&backend).unwrap().display().to_string())
        .collect();
    found.sort();
    let mut listed: Vec<String> = LOOPS.iter().map(|(path, _)| (*path).to_owned()).collect();
    listed.sort();
    assert_eq!(
        found, listed,
        "a periodic loop must be safe with two workers at once (BG-6): claim per row/org \
         (SKIP LOCKED, idempotency key, advisory lock, lease) and list it in LOOPS with its mechanism"
    );
}
