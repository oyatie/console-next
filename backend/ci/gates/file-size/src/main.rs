//! Runs the file-size ratchet over the backend tree.
//!
//! * no flags: check every Rust file against its ceiling and [`BASELINE`].
//! * `--write-baseline`: rewrite [`BASELINE`] from the tree as it is now.
//! * `--against <git-rev>`: also fail if [`BASELINE`] raised a pin or the pinned
//!   total relative to that revision (CI passes the merge base).

mod registry;

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use console_gate_file_size::{
    BASELINE, Counts, Finding, check, measure, missing_exemptions, oversize, parse_baseline,
    ratchet, render_baseline,
};

fn main() -> ExitCode {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&root, &args) {
        Ok(findings) if findings.is_empty() => ExitCode::SUCCESS,
        Ok(findings) => {
            for finding in &findings {
                println!("file-size VIOLATION: {finding}");
            }
            println!("file-size: FAILED, {} violation(s)", findings.len());
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("file-size: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(root: &Path, args: &[String]) -> Result<Vec<Finding>, String> {
    let counts = measure(root).map_err(|e| format!("cannot walk {}: {e}", root.display()))?;
    let baseline_path = root.join(BASELINE);
    match args {
        [flag] if flag == "--write-baseline" => {
            let pins = oversize(&counts);
            std::fs::write(&baseline_path, render_baseline(&pins))
                .map_err(|e| format!("cannot write {BASELINE}: {e}"))?;
            registry::clear(root)?;
            println!("file-size: wrote {} pins to {BASELINE}", pins.len());
            return Ok(missing_exemptions(root));
        }
        [flag, lane] if flag == "--write-lane-baseline" => {
            registry::write_lane(root, lane, &counts)?;
            return Ok(Vec::new());
        }
        [] | [_, _] => {}
        _ => {
            return Err(
                "usage: console-gate-file-size [--write-baseline | --against <git-rev>]".into(),
            );
        }
    }
    let text = std::fs::read_to_string(&baseline_path)
        .map_err(|e| format!("cannot read {BASELINE}: {e}"))?;
    let pins = registry::read(root, parse_baseline(&text)?)?;
    let mut findings = check(&counts, &pins);
    findings.extend(missing_exemptions(root));
    if let [flag, rev] = args {
        if flag != "--against" {
            return Err(format!("unknown flag {flag}"));
        }
        match previous_baseline(root, rev)? {
            Some(old) => findings.extend(ratchet(&old, &pins)),
            None => println!("file-size: {rev} has no {BASELINE}; ratchet starts here"),
        }
    }
    println!(
        "file-size: {} files measured, {} pinned, {} violation(s)",
        counts.len(),
        pins.len(),
        findings.len()
    );
    Ok(findings)
}

/// The baseline at `rev`, or `None` when that revision predates the gate.
/// An unknown `rev` is an error, not "no baseline": a typo must not skip the ratchet.
fn previous_baseline(root: &Path, rev: &str) -> Result<Option<Counts>, String> {
    if !git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )?
    .status
    .success()
    {
        return Err(format!("unknown revision {rev}"));
    }
    let blob = format!("{rev}:./{BASELINE}");
    if !git(root, &["cat-file", "-e", &blob])?.status.success() {
        return Ok(None);
    }
    let shown = git(root, &["show", &blob])?;
    if !shown.status.success() {
        return Err(format!("git show {blob} failed"));
    }
    let pins = parse_baseline(&String::from_utf8_lossy(&shown.stdout))?;
    let files = git(
        root,
        &[
            "ls-tree",
            "-r",
            "--name-only",
            rev,
            "--",
            &format!("./{}", registry::DIRECTORY),
        ],
    )?;
    if !files.status.success() {
        return Err("cannot read previous baseline contributions".into());
    }
    let mut contributions = Vec::new();
    for path in String::from_utf8_lossy(&files.stdout)
        .lines()
        .filter(|path| path.ends_with(".txt"))
    {
        let entry = git(root, &["show", &format!("{rev}:./{path}")])?;
        if !entry.status.success() {
            return Err(format!("cannot read previous contribution {path}"));
        }
        contributions.push((
            path.into(),
            parse_baseline(&String::from_utf8_lossy(&entry.stdout))?,
        ));
    }
    registry::merge(pins, contributions).map(Some)
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run git: {e}"))
}
