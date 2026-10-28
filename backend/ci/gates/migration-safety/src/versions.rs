use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::{GateResult, Violation, ViolationKind};

pub(crate) fn check_migration_versions(files: &[PathBuf], result: &mut GateResult) {
    let mut roots: BTreeMap<PathBuf, BTreeMap<i64, Vec<PathBuf>>> = BTreeMap::new();
    for file in files {
        let prefix = file
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.split_once('_'))
            .map(|(prefix, _)| prefix);
        let version = prefix
            .filter(|prefix| {
                matches!(prefix.len(), 4 | 14 | 17)
                    && prefix.bytes().all(|byte| byte.is_ascii_digit())
            })
            .and_then(|prefix| prefix.parse::<i64>().ok());
        let Some(version) = version else {
            result.violations.push(Violation {
                kind: ViolationKind::InvalidMigrationVersion,
                file: file.clone(),
                detail: "expected NNNN_name.sql or UTC YYYYMMDDHHMMSS[mmm]_name.sql".into(),
            });
            continue;
        };
        roots
            .entry(file.parent().unwrap_or_else(|| Path::new("")).to_owned())
            .or_default()
            .entry(version)
            .or_default()
            .push(file.clone());
    }
    for (root, versions) in roots {
        let mut expected = 1;
        for (version, files) in versions {
            if files.len() > 1 {
                result.violations.push(Violation {
                    kind: ViolationKind::DuplicateMigrationVersion,
                    file: files[0].clone(),
                    detail: format!("migration version {version} is used more than once"),
                });
            }
            // Historical timestamps may be unordered; the PR gate checks additions against its base.
            if version < 10_000 && version != 0 {
                if version != expected {
                    result.violations.push(Violation {
                        kind: ViolationKind::NonContiguousMigrationVersion,
                        file: root.clone(),
                        detail: format!(
                            "missing migration version {expected:04} before {version:04}"
                        ),
                    });
                }
                expected = version + 1;
            }
        }
    }
}
