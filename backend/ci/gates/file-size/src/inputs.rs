// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{Counts, EXEMPT, ROOTS, count, exempt_matches};
use std::path::Path;

/// Counts every non-exempt `*.rs` under [`ROOTS`], skipping `target` and
/// hidden directories.
///
/// # Errors
/// Any directory or file that cannot be read.
pub fn measure(root: &Path) -> std::io::Result<Counts> {
    let mut counts = Counts::new();
    for dir in ROOTS {
        let path = root.join(dir);
        if !path.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("required source directory {} is missing", path.display()),
            ));
        }
        walk(root, &path, &mut counts)?;
    }
    if counts.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "no Rust source files found",
        ));
    }
    Ok(counts)
}

fn walk(root: &Path, dir: &Path, counts: &mut Counts) -> std::io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if path.is_dir() {
            if name != "target" && !name.starts_with('.') {
                walk(root, &path, counts)?;
            }
            continue;
        }
        if path.extension().is_none_or(|ext| ext != "rs") {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path);
        let key = relative.to_string_lossy().replace('\\', "/");
        if !EXEMPT
            .iter()
            .any(|(pattern, _)| exempt_matches(pattern, &key))
        {
            let lines = count::code_lines(&key, &std::fs::read_to_string(&path)?);
            counts.insert(key, lines);
        }
    }
    Ok(())
}
