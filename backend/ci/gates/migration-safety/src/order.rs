// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn check(workspace_dir: &Path) -> Result<(), String> {
    let Some(base) = std::env::var_os("MIGRATION_BASE").filter(|base| !base.is_empty()) else {
        return Ok(());
    };
    let base = base.to_str().ok_or("MIGRATION_BASE must be UTF-8")?;
    let previous = migration_versions(workspace_dir, base)?;
    let current = migration_versions(workspace_dir, "HEAD")?;
    let mut newest: BTreeMap<&Path, (&Path, i64)> = BTreeMap::new();
    for (file, &version) in &previous {
        let root = file.parent().unwrap_or_else(|| Path::new(""));
        newest
            .entry(root)
            .and_modify(|entry| {
                if version > entry.1 {
                    *entry = (file, version);
                }
            })
            .or_insert((file, version));
    }

    let mut violations = Vec::new();
    for (file, version) in &current {
        if previous.contains_key(file) {
            continue;
        }
        let root = file.parent().unwrap_or_else(|| Path::new(""));
        if let Some((latest_file, latest_version)) = newest.get(root)
            && version <= latest_version
        {
            violations.push(format!(
                "{}: added migration version {version} must sort after newest base version \
                 {latest_version} ({} on {base})",
                file.display(),
                latest_file.display()
            ));
        }
    }
    if violations.is_empty() {
        Ok(())
    } else {
        Err(violations.join("\n"))
    }
}

pub(crate) fn migration_versions(
    root: &Path,
    revision: &str,
) -> Result<BTreeMap<PathBuf, i64>, String> {
    let output = Command::new("git")
        .args([
            "ls-tree",
            "-r",
            "--full-name",
            "--name-only",
            "-z",
            revision,
            "--",
            ".",
        ])
        .current_dir(root)
        .output()
        .map_err(|error| format!("cannot read migration history at {revision}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "cannot read migration history at {revision}: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let paths = String::from_utf8(output.stdout)
        .map_err(|error| format!("migration paths at {revision} must be UTF-8: {error}"))?;
    let mut versions = BTreeMap::new();
    for name in paths.split('\0').filter(|name| !name.is_empty()) {
        let file = Path::new(name);
        if file.extension().is_none_or(|ext| ext != "sql")
            || !file
                .components()
                .any(|part| part.as_os_str() == "migrations")
            || file
                .components()
                .any(|part| matches!(part.as_os_str().to_str(), Some("target" | ".git")))
        {
            continue;
        }
        let version = file
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.split_once('_'))
            .and_then(|(prefix, _)| prefix.parse::<i64>().ok())
            .ok_or_else(|| format!("invalid migration version at {revision}: {name}"))?;
        versions.insert(file.to_owned(), version);
    }
    Ok(versions)
}
